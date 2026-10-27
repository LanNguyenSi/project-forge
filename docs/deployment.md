# Deployment: project-forge

## Docker Compose

The root `docker-compose.yml` ships two services:

- `app`: the project-forge Next.js runtime.
- `planforge`: the agent-planforge HTTP service (per
  [ADR-0002](adrs/0002-tool-decoupling-service-boundary.md)). Built from a
  pinned revision of the public agent-planforge repo (see
  [Planforge version](#planforge-version)). Runs both the planforge CLI and scaffoldkit
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

### Planforge version

The `planforge` image is built from a git URL build context pinned to an
explicit ref, in one place: the default of `PLANFORGE_CONTEXT` on the
`planforge` service in `docker-compose.yml`
(`https://github.com/LanNguyenSi/agent-planforge.git#2438f9a47da23de378b0943e8f073a41decdb00a`, the agent-planforge main commit after v0.6.0 that bumps scaffoldkit to v0.4.3, which production built from before the pin). No sibling
checkout is needed; the Docker daemon that runs the build fetches the ref from
GitHub, so that host needs outbound HTTPS to github.com and a BuildKit-enabled
Docker (the default in current Docker and Compose). A rollback rebuilds the
same planforge revision.

To update planforge, change the ref after `#` to another release tag or a full
40-character commit SHA (a one-line change), then deploy. Do not use a branch
name: it would make the build depend on whatever the branch holds at build
time.

For local development against an agent-planforge checkout, set
`PLANFORGE_CONTEXT=../agent-planforge` in `.env` (or the shell). This is never
the default. Set it in `.env`, not in `docker-compose.override.yml`: the
override only changes service config after compose has interpolated the file,
and deploy tooling that runs `docker compose -f docker-compose.yml` skips the
override entirely.

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
gives the container 60 seconds to run `scripts/start.sh` (`prisma migrate deploy`,
plus the pre-migrate copy when a migration is pending) and start, then probes
every 15 seconds; five failures in a row mark it `unhealthy`
(`docker compose ps`). Because the check reads the route, a server that
refuses to serve (see above) is `unhealthy` too. Docker does not restart an
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

## Database migrations

The schema changes through committed Prisma migrations in `prisma/migrations/`
(SQLite, `migration_lock.toml` says `provider = "sqlite"`). The container does
not run `prisma db push` any more. Its start command is
`sh scripts/start.sh node_modules/.bin/next start`; the script brings the
database file to the committed schema and only then starts the server. The
database path is the one in `DATABASE_URL` (default
`file:/data/project-forge.db` on the `forge_db` volume).

| State of the database file | What start does |
|---|---|
| File missing, or no table in it | `prisma migrate deploy` creates the schema. No copy. |
| Has `_prisma_migrations`, nothing pending | `migrate deploy` (a no-op). No copy. |
| Has `_prisma_migrations`, a migration is pending (or `migrate status` fails) | Copy the file, then `migrate deploy`. |
| Has tables but no `_prisma_migrations` (created by the old `db push` start) and equals `prisma/schema.prisma` | Copy the file, mark the baseline migration as applied (`migrate resolve --applied`), then `migrate deploy`. |
| Has tables but no `_prisma_migrations` and differs from `prisma/schema.prisma`, or the comparison fails | Abort. Nothing is changed, the server does not start. |

Any failure of the copy, the check, the resolve or the deploy ends the start
with a non-zero exit and the server is not started. Nothing falls back to
`db push`. Compose restarts the container (`restart: unless-stopped`), so a
failure shows up as a restart loop and an `unhealthy` container; read it with
`docker compose logs app`. A deploy tool that rolls back on a failed health
check (`rollback: true` in `.relay.yml`) puts the previous code back; see
[Rollback](#rollback) for what that does not undo.

### Auto-baseline and the abort message

A database that the old start command created has the right tables but no
migration history, so `prisma migrate deploy` alone refuses it (`P3005`). The
first start of this release compares the file with `prisma/schema.prisma`
(`prisma migrate diff ... --exit-code`, read-only). Only an exact match is
baselined. If the file differs, the log shows what differs and then:

```
[db-start] ERROR: the existing database /data/project-forge.db differs from prisma/schema.prisma (differences above), so it was NOT baselined and nothing was changed. The server was not started and no 'prisma db push' is run. Bring the database in line with the schema, or baseline it by hand once you have verified the differences: see docs/deployment.md, section "Database migrations".
```

Recovery (the database file is untouched, the container keeps restarting until
you act):

1. Stop the restart loop: `docker compose stop app`.
2. Take your own copy of the file: `docker compose run --rm --no-deps app sh -c 'cp /data/project-forge.db /data/project-forge.db.manual-$(date -u +%Y%m%dT%H%M%SZ)'` (adjust the path if `FORGE_DATABASE_URL` is set).
3. See the SQL that would turn the database into the schema (read-only):
   `docker compose run --rm --no-deps app sh -c 'node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script'`
4. Choose one:
   - Bring the database to the schema: review the script, apply the statements
     you accept (for example with `sqlite3` in the same one-off container), and
     repeat step 3 until it prints `-- This is an empty migration.`. The next
     start then baselines on its own.
   - The differences are harmless and you want to keep the file as it is: record
     the baseline by hand with
     `docker compose run --rm --no-deps app node_modules/.bin/prisma migrate resolve --applied 20261027000000_baseline`.
     This marks the migration as applied without running it, so the differences
     stay in the database. Do this only after reading the diff.
5. `docker compose up -d app`.

The comparison is against `prisma/schema.prisma` of the image being started.
That is exact for the first start after the `db push` era, which is what
auto-baseline is for. Once a release adds a migration after the baseline, a
legacy file that was never started on migrations still has the old shape and
is refused too. Then the differences are exactly what the later migrations
create: baseline by hand (the second choice in step 4) and let the start apply
those migrations. Do not apply the SQL yourself in that case, the migration
would fail on the second run.

### Pre-migrate copy

Before the baseline is recorded, and before `migrate deploy` when a migration
is pending, the start script copies the database to
`<database file>.pre-migrate-<UTC timestamp>` in the same directory, which is
`/data/project-forge.db.pre-migrate-20261027T132758Z` on the `forge_db` volume
by default. The copy is made with `sqlite3 .backup` (the runner image installs
`sqlite3`), so it is consistent, and the file mode is `600` because the
database holds password hashes and GitHub tokens. It is a full-size copy on the
same volume: check the free space before a large deploy. If the copy cannot be
written, the start aborts before anything is changed.

A start with no pending migration makes no copy. A restart loop does not pile
up copies: when the database is byte-identical to the newest copy, that copy is
kept and no new one is written.

Nothing deletes the copies. List and remove them once the new version has run
well:

```
docker compose run --rm --no-deps app sh -c 'ls -l /data/*.pre-migrate-*'
docker compose run --rm --no-deps app sh -c 'rm /data/project-forge.db.pre-migrate-<timestamp>'
```

To go back to a copy: `docker compose stop app`, then replace
`/data/project-forge.db` with the copy (`cp` it over the file in a one-off
container) and remove any `project-forge.db-journal` next to it.

### Rollback

`rollback: true` in `.relay.yml` and a manual `docker compose up` of an older
checkout both change the code only. They do not undo a migration: the database
keeps the schema the newer release gave it. An older image that still ran
`prisma db push` at start (0.8.0 and earlier) accepts the database as long as
the schema did not change in between (checked: `db push` reports it is already
in sync and leaves `_prisma_migrations` alone), but once a migration changed the
schema, the older code can fail or, with `db push`, refuse the new shape. To
return to the schema of the older release, restore the pre-migrate copy as
described above, then start the older release.

### Writing migrations (expand and contract)

- Create the migration with the schema change: `npx prisma migrate dev --name <what changed>`,
  review the SQL, commit `prisma/migrations/<timestamp>_<name>/`. CI runs
  `sh scripts/check-migrations.sh` and fails when the schema and the migrations
  disagree.
- Migrations run in order at the next container start, with no operator step
  in between. A migration that drops or rewrites data therefore runs on that
  deploy, whatever else you planned.
- For a change that needs a data transform (SQLite has no HMAC or SHA-256, so
  the 0.7.0 token hashing was done in Node), split it over two releases:
  1. **Expand** release: a migration that only adds (new nullable column, new
     table), code that works with both shapes, and a backfill script run
     out of band as in [Upgrading to 0.7.0](#upgrading-to-070).
  2. **Contract** release, after the backfill is verified: the migration that
     drops the old column or adds `NOT NULL`. If the data does not fit, the
     migration fails and the start aborts; the pre-migrate copy is the way
     back.
- A migration that fails halfway leaves a failed entry in `_prisma_migrations`;
  every later start then stops with `P3009`. Restore the pre-migrate copy (or
  repair the database by hand), then mark the migration with
  `prisma migrate resolve --rolled-back <name>` or `--applied <name>` as
  appropriate before starting again.

## Upgrading to committed migrations

The release that adds `prisma/migrations/` replaces the container's
`prisma db push` with `scripts/start.sh` (see [Database migrations](#database-migrations)).
What the next deploy does, with the database at `file:/data/project-forge.db`:

1. The image is rebuilt; it now contains `sqlite3`, `scripts/start.sh` and the
   baseline migration.
2. The container starts, finds tables but no `_prisma_migrations`, and compares
   the file with `prisma/schema.prisma`.
3. If they are equal: it writes
   `/data/project-forge.db.pre-migrate-<UTC timestamp>` (a full copy on the
   `forge_db` volume), records `20261027000000_baseline` as applied, runs
   `migrate deploy` (nothing to apply), and starts the server. The log shows
   `[db-start] pre-migrate copy written: ...`.
4. If they differ, or the copy cannot be written: the container exits with
   `[db-start] ERROR: ...`, the database file is untouched, and the health
   check fails; with `rollback: true` the relay restores the previous code (the
   old image's `db push` accepts the untouched file). Recover as described under
   [Auto-baseline and the abort message](#auto-baseline-and-the-abort-message).

Before deploying, check which of 3 and 4 applies, read-only, in the running
container (its `prisma/schema.prisma` is the schema the new image compares
against, as long as the release does not change the schema):

```
docker compose exec app sh -c 'node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code'
```

Exit 0 and `No difference detected.` means step 3. Exit 2 lists the
differences: fix them first (recovery step 4) or accept the abort. Also check
that the volume has room for a copy of the database file.

One-time manual step: none when the check passes. For local development,
`npm run db:push` is gone: use `npx prisma migrate deploy` for a fresh database
(see `CONTRIBUTING.md` for a database that `db push` created). Delete the
pre-migrate copy once the new version has run well.

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

- **`PLANFORGE_SERVICE_TOKEN`.** Must be a non-empty value in `.env` (or the
  shell), also when the override sets it: compose interpolates
  `docker-compose.yml` before merging the override. A setup whose token only
  lives in the override worked before; it now stops every compose command with
  an error naming the variable, so move the token into `.env` first.
- **Database path. Check BEFORE deploying (and before pulling the new compose
  file), never after.** Read the live value:
  `docker compose exec app printenv DATABASE_URL`.
  - `file:/data/project-forge.db`: nothing changes.
  - Another path under `/data` (on the `forge_db` volume): set
    `FORGE_DATABASE_URL` in `.env` to that value so the container keeps using it.
  - Anything outside `/data` (for example `file:./db/project-forge.db` from a
    missing override, which the previous compose file left inside the container
    layer): the deploy recreates the container and that layer is discarded, so
    setting `FORGE_DATABASE_URL` to it does not keep the data. Copy the file onto
    the volume first, with the app idle, from the old container:
    `docker compose exec app cp /app/prisma/db/project-forge.db /data/project-forge.db`
    (then leave `FORGE_DATABASE_URL` unset, or point it at the copy under
    `/data`). The Prisma schema lives in `/app/prisma`, so a relative
    `file:./db/...` resolves to `/app/prisma/db/...`; adjust the source path for
    other values.
- **Existing override.** `DATABASE_URL`, `NEXTAUTH_SECRET` and `NEXTAUTH_URL`
  set only in `docker-compose.override.yml` keep working for plain
  `docker compose` runs and are silently absent from deploys that use
  `-f docker-compose.yml`. Move the ones those deploys need into `.env`
  (`FORGE_DATABASE_URL` for the database path).
- **`NEXTAUTH_SECRET`.** Must be a real value in `.env` or, for plain compose
  runs, in the override; the placeholder from the example files, or no value,
  makes the production server answer 500 and the container `unhealthy`.
- **Logs and health.** The `json-file` rotation applies after the containers
  are recreated; the healthcheck starts out `starting` for up to 60 seconds.
  If you use `.relay.yml`, its `health: /` check is unchanged.

## Upgrading to 0.7.0

This section predates committed migrations: at 0.7.0 the container ran
`prisma db push` at start, and the steps below (including "its `db push` is now
a clean no-op") describe that. The expand and contract scripts are plain SQL
and still work. When you upgrade from a version before 0.7.0 straight to a
release with migrations, do these steps first: a database that still has the
plaintext `token` column differs from `prisma/schema.prisma`, so the new start
aborts (see [Database migrations](#database-migrations)) instead of baselining
it. After step 5 the start script's check passes and baselines the file in
place of step 6's `db push`.

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
