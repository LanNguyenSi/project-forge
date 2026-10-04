# Deployment: project-forge

## Docker Compose

The root `docker-compose.yml` ships two services:

- `app`: the project-forge Next.js runtime.
- `planforge`: the agent-planforge HTTP service (per
  [ADR-0002](adrs/0002-tool-decoupling-service-boundary.md)). Built from the
  sibling `agent-planforge` checkout via `context: ../agent-planforge` (see
  `docker-compose.yml`). Runs both the planforge CLI and scaffoldkit
  in-container. **Internal-only**, no Traefik labels, no published ports.
  `app` reaches it via the shared `traefik` docker network at
  `http://planforge:8223`.

For a persistent SQLite database, copy `docker-compose.override.example.yml`
to `docker-compose.override.yml` before the first deploy. It sets
`DATABASE_URL=file:/data/project-forge.db` and mounts the `forge_db` volume at
`/data`; without it `.env.example`'s `file:./db/project-forge.db` is used and
the database is not on the volume.

Both services need `PLANFORGE_SERVICE_TOKEN` in `.env`. Compose propagates
it; mismatched values cause `app` to get 401s from `planforge`.

## Service Token Rotation (manual, v1)

```bash
cd <path to your project-forge checkout>
NEW_TOKEN=$(openssl rand -hex 32)
sed -i "s/^PLANFORGE_SERVICE_TOKEN=.*/PLANFORGE_SERVICE_TOKEN=$NEW_TOKEN/" .env
docker compose up -d --build  # rebuild both so the new token is live simultaneously
```

A token store + in-place rotation is a follow-up (see
[ADR-0002](adrs/0002-tool-decoupling-service-boundary.md)).

## Upgrading to 0.7.0

0.7.0 stores API tokens hashed: `ApiToken.token` is replaced by
`tokenHash` and `tokenPrefix`. The container's start command runs
`npx prisma db push --skip-generate` without `--accept-data-loss`, so on a
database that still holds plaintext tokens the new container exits at
start-up and does not serve requests. A data migration has to run during
the deploy. The runner image does not ship `scripts/`, and the SQLite file
lives on the `forge_db` volume (`DATABASE_URL=file:/data/project-forge.db`
in `docker-compose.override.yml`), so the script is run in a one-off
container that mounts the checkout's `scripts/` directory next to the
volume.

Run everything from the checkout that holds `docker-compose.yml`,
`docker-compose.override.yml` and `.env`, after pulling 0.7.0. The one-off
containers read the same environment as the `app` service, which is what
makes the hash key below match.

1. Build the new image without restarting anything:
   `docker compose build app`
2. Expand while the old container is still serving (additive, the old code
   keeps working):
   `docker compose run --rm --no-deps -v ./scripts:/app/scripts app node scripts/backfill-api-token-hashes.js`
3. Stop the old container (the brief downtime a normal redeploy has too):
   `docker compose stop app`
4. Expand again. Required: it hashes tokens created between step 2 and
   step 3. It must print `Backfilling N token(s)...` and exit 0; if it
   reports rows without a `tokenHash`, stop and fix those rows, because
   contract refuses too.
   `docker compose run --rm --no-deps -v ./scripts:/app/scripts app node scripts/backfill-api-token-hashes.js`
5. Contract (drops the plaintext `token` column and its index):
   `docker compose run --rm --no-deps -v ./scripts:/app/scripts app node scripts/backfill-api-token-hashes.js --contract`
6. Start the new container; its `db push` is now a clean no-op:
   `docker compose up -d app`

Steps 4 and 5 are the cutover and must not be reordered around step 3:
contract while the old container is live breaks every token-authenticated
request, and starting the new container before contract makes it exit.
The scripts are idempotent, so a failed run can be repeated.

### Hash key

Tokens are hashed with HMAC-SHA256 keyed by `API_TOKEN_HASH_SECRET`, or
`NEXTAUTH_SECRET` when that is unset. The backfill must run with the same
key the new container will use, which holds when both read it from the
same `.env` / override file as above. If the key differs (or is changed
later), the stored hashes no longer match what the new container computes
for a presented token, and every existing API token is rejected after the
cutover; the owners then have to issue new tokens. If neither variable is
set the script refuses to run.

### Behaviour changes to expect

- `GET /api/dashboard` returns `tokenPrefix` instead of the raw token and
  `githubPatConnected` instead of the GitHub PAT; the PAT is available to
  its owner through `GET /api/dashboard/pat`.
- A repeat `register-from-project-pilot` call revokes the previous token
  and returns a new one.
