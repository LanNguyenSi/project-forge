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

Copy `docker-compose.override.example.yml` to `docker-compose.override.yml`
before the first manual deploy and replace its `NEXTAUTH_SECRET` placeholder
with a fresh `openssl rand -hex 32` value (or delete that line and the
`NEXTAUTH_URL` line from the override so the `.env` values apply). Do not leave
the placeholder in place: `NEXTAUTH_SECRET` is also the fallback key for
hashing API tokens when `API_TOKEN_HASH_SECRET` is unset, and the app refuses
to serve with the placeholder or an empty value (see
[Required secrets](#required-secrets)).

**Deploys through deploy-panel and agent-relay never load the override.** The
relay runs every compose command as `docker compose -f docker-compose.yml ...`
(`compose_file` in `.relay.yml`), and an explicit `-f` replaces the default
file lookup, so `docker-compose.override.yml` is skipped. Everything such a
deploy needs comes from `docker-compose.yml`, `.env` and the shell of the
relay: put the secrets and a non-default database path in `.env`, not in the
override. `make deploy` and `make pull` run plain `docker compose`, which does
load the override.

### Database location

`docker-compose.yml` sets the container's `DATABASE_URL` to
`${FORGE_DATABASE_URL:-file:/data/project-forge.db}`. The default is the
`forge_db` volume, so the database survives a rebuild plus recreate.
`FORGE_DATABASE_URL` is a compose-only knob: set it in `.env` (or the shell,
which wins over `.env`) to use another file on the volume. An empty value
counts as unset. Precedence, highest first:

1. `docker-compose.override.yml`, `services.app.environment.DATABASE_URL`.
   Applies to plain `docker compose` only, never with `-f docker-compose.yml`.
2. `FORGE_DATABASE_URL` from the shell, then from `.env`.
3. The default `file:/data/project-forge.db`.

The `DATABASE_URL` in `.env` (the local development path
`file:./db/project-forge.db` from `.env.example`) does not reach the
container: the `environment:` block of the compose file beats `env_file`, and
compose interpolates only `FORGE_DATABASE_URL`. A `DATABASE_URL` exported in
the shell is ignored for the same reason. Local development (`npm run dev`,
`make dev`) still reads `.env`.

Resulting container `DATABASE_URL`, checked with `docker compose config` (plain)
and `docker compose -f docker-compose.yml config` (the relay path):

| Inputs | plain | `-f docker-compose.yml` |
|---|---|---|
| nothing set | `file:/data/project-forge.db` | `file:/data/project-forge.db` |
| `.env` `DATABASE_URL` only | `file:/data/project-forge.db` | `file:/data/project-forge.db` |
| `.env` `FORGE_DATABASE_URL=file:/data/env.db` | `file:/data/env.db` | `file:/data/env.db` |
| shell `FORGE_DATABASE_URL=file:/data/shell.db` | `file:/data/shell.db` | `file:/data/shell.db` |
| override `DATABASE_URL=file:/data/override.db` | `file:/data/override.db` | `file:/data/project-forge.db` |

Check the effective value with
`docker compose -f docker-compose.yml config | grep 'DATABASE_URL'`
(the plain form shows what a manual run would use). On a running stack,
`docker compose exec app printenv DATABASE_URL` shows what the container has.

### Required secrets

- `PLANFORGE_SERVICE_TOKEN` is read for both services from `.env` or the shell.
  Compose interpolates `docker-compose.yml` before it merges the override, so
  a token that only the override sets does not satisfy the check, even though
  the app would receive it. Compose refuses to run any command, including
  `docker compose up` and `docker compose config`, while it is unset or empty,
  and names the variable in the error.
- `NEXTAUTH_SECRET` may be set in `.env` or, for plain `docker compose` runs,
  in the override. On deploys through agent-relay (override not loaded) it must
  be in `.env`. The `app` container checks it when the production server
  starts: with a missing or empty value, or a placeholder copied from
  `.env.example` or the override example, the process keeps running but every
  request returns 500 and the error is logged
  (`Refusing to serve: NEXTAUTH_SECRET ...`), and the healthcheck fails.
  `next dev`, `next build` and the test run are not affected.

### Health check and logs

The `app` service has a compose healthcheck against `GET /api/health`, a
public route that answers `{"ok":true}` without touching the database. It
gives the container 60 seconds to run `prisma db push` and start, then probes
every 15 seconds; five failures in a row mark it `unhealthy`
(`docker compose ps`). Because the check reads the route, a server that
refuses to start (see above) is `unhealthy` too. Docker does not restart an
unhealthy container on its own; the check is the signal for operators and
deploy tooling.

Both services use the `json-file` log driver with `max-size: 10m` and
`max-file: 3`, so each service keeps at most 30 MB of logs on the host.

Both services need `PLANFORGE_SERVICE_TOKEN` in `.env`. Compose propagates
it; mismatched values cause `app` to get 401s from `planforge`.

### Routing

The `app` service publishes no host port and is reached through Traefik. Its
labels in `docker-compose.yml` set the router rule `Host(...)` to the upstream
hostname, the entrypoint `websecure`, and the certificate resolver
`letsencrypt`. For your own instance, redefine these labels in
`docker-compose.override.yml` (Compose merges labels by key):

```yaml
services:
  app:
    labels:
      traefik.http.routers.project-forge.rule: Host(`forge.example.com`)
      traefik.http.routers.project-forge.entrypoints: <your entrypoint>
      traefik.http.routers.project-forge.tls.certresolver: <your resolver>
```

Set `NEXTAUTH_URL` to the same public URL. To run without Traefik, add
`ports: ["3000:3000"]` under `app` in the override and use
`http://localhost:3000` as `NEXTAUTH_URL`; the external `traefik` network must
still exist.

### Session cleanup

Generated sessions live in `FORGE_TEMP_DIR` (`/tmp/project-forge` on the
`forge_tmp` volume). There is no background cleanup: an expired session is
removed only when it is read again, and a published one right after the push.
Sessions that are never previewed or published stay on the volume, together
with any uploaded documents, and the `forge_tmp` volume grows until someone
prunes it. This is an operator step, not something the stack does. Prune
periodically, for example:

```bash
docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} +
```

As a host crontab entry (hourly, from the checkout that holds
`docker-compose.yml`):

```cron
0 * * * * cd /path/to/project-forge && docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} +
```

## Service Token Rotation (manual, v1)

```bash
cd <path to your project-forge checkout>
NEW_TOKEN=$(openssl rand -hex 32)
sed -i "s/^PLANFORGE_SERVICE_TOKEN=.*/PLANFORGE_SERVICE_TOKEN=$NEW_TOKEN/" .env
docker compose up -d --build  # rebuild both so the new token is live simultaneously
```

A token store + in-place rotation is a follow-up (see
[ADR-0002](adrs/0002-tool-decoupling-service-boundary.md)).

## Upgrading to the safe-by-default compose stack

This change moves several defaults into `docker-compose.yml`. Check these
before the next deploy (`make deploy` and `make pull` now rebuild with
`--build`; deploy-panel deploys skip the override, see
[Docker Compose](#docker-compose)):

- **Database path. Check BEFORE deploying, never after.** Read the live value:
  `docker compose exec app printenv DATABASE_URL`.
  - `file:/data/project-forge.db`: nothing changes.
  - Anything else (for example `file:./db/project-forge.db` from a missing
    override, which the previous compose file left inside the container layer):
    the new default would point at an empty database on the `forge_db` volume.
    Either set `FORGE_DATABASE_URL` in `.env` to that live value so the
    container keeps using it, or copy the file onto the volume with the app
    idle before the deploy:
    `docker compose exec app cp /app/prisma/db/project-forge.db /data/project-forge.db`.
    The Prisma schema lives in `/app/prisma`, so a relative `file:./db/...`
    resolves to `/app/prisma/db/...`; adjust the source path for other values.
    Do this against the old container; once it is recreated, the file in its
    layer is gone.
- **Existing override.** `DATABASE_URL`, `NEXTAUTH_SECRET` and `NEXTAUTH_URL`
  set only in `docker-compose.override.yml` keep working for plain
  `docker compose` runs and are silently absent from deploys that use
  `-f docker-compose.yml`. Move the ones those deploys need into `.env`
  (`FORGE_DATABASE_URL` for the database path).
- **`PLANFORGE_SERVICE_TOKEN`.** Must be a non-empty value in `.env` (or the
  shell), also when the override sets it: compose interpolates
  `docker-compose.yml` before merging the override. A setup whose token only
  lives in the override worked before; it now stops every compose command with
  an error naming the variable, so move the token into `.env` first.
- **`NEXTAUTH_SECRET`.** Must be a real value in `.env` or, for plain compose
  runs, in the override; the placeholder from the example files, or no value,
  makes the production server answer 500 and the container `unhealthy`.
- **Logs and health.** The `json-file` rotation applies after the containers
  are recreated; the healthcheck starts out `starting` for up to 60 seconds.
  If you use `.relay.yml`, its `health: /` check is unchanged.

## Upgrading to 0.7.0

0.7.0 stores API tokens hashed: `ApiToken.token` is replaced by
`tokenHash` and `tokenPrefix`. The container's start command runs
`npx prisma db push --skip-generate` without `--accept-data-loss`, so on a
database that still holds plaintext tokens the new container exits at
start-up and does not serve requests. A data migration has to run during
the deploy. The runner image does not ship `scripts/`, and the SQLite file
lives on the `forge_db` volume (`DATABASE_URL=file:/data/project-forge.db`,
the default in `docker-compose.yml`), so the script is run in a one-off
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
