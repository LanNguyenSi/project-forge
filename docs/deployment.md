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
  `http://planforge:8223`. Carries the same privilege hardening as `app`
  (`security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, no capability
  added back; the check that established it for the pinned commit is under
  [Planforge version](#planforge-version)).

Copy `docker-compose.override.example.yml` to `docker-compose.override.yml`
before the first manual deploy and replace its two placeholders: `NEXTAUTH_SECRET`
with a fresh `openssl rand -hex 32` value and `NEXTAUTH_URL` with the public
`https://` URL of your instance (or delete both lines from the override so the
`.env` values apply). Do not leave
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
override, and the same for a non-default planforge URL: set
`FORGE_PLANFORGE_URL` there (compose only; unset or empty means the internal
`http://planforge:8223`; the `PLANFORGE_URL` in `.env` is for local
development and does not reach the container). `make deploy` and `make pull`
run plain `docker compose`, which does load the override.

### Planforge version

The `planforge` image is built from a git URL build context pinned to an
explicit ref, in one place: the default of `PLANFORGE_CONTEXT` on the
`planforge` service in `docker-compose.yml`
(`https://github.com/LanNguyenSi/agent-planforge.git#88a5453a49bba5fd63588c5015bb754645d3f74e`, the agent-planforge main commit after its PR #145 change "terminateChild signals the whole process group; SIGKILL gated on stream close", so terminating a run reaches the planforge CLI's own child processes too). No sibling
checkout is needed; the Docker daemon that runs the build fetches the ref from
GitHub, so that host needs outbound HTTPS to github.com and a BuildKit-enabled
Docker (the default in current Docker and Compose). A rollback rebuilds the
same planforge revision.

To update planforge, change the ref after `#` to another release tag or a full
40-character commit SHA (a one-line change), then deploy. Do not use a branch
name: it would make the build depend on whatever the branch holds at build
time.

The `planforge` service runs with `security_opt: [no-new-privileges:true]`
and `cap_drop: [ALL]`, no capability added back (the same hardening as
`app`). Because the image comes from an external repository at a pinned
commit, its runtime needs cannot be read from this repo; they are
established for the pinned commit by a container runtime check: the
container starts, `/healthz` answers 200, and a scaffold request succeeds.
That check passed for the commit pinned above. When you change the ref,
deploy the new pin and re-run the check on the deployed stack:
`docker compose ps` shows planforge `healthy`;
`docker compose exec planforge node -e "require('http').get('http://localhost:8223/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"`
exits 0 (the probe of the service's own healthcheck); then run one real
scaffold request through the app.
Watch `docker compose logs planforge` for a capability error (`EPERM` /
`Operation not permitted`): it means the new commit needs a capability the
dropped set held, so add back only that one capability with `cap_add` and a
reason in `docker-compose.yml` (the app's hardening comment shows the
style), never the whole default set.

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
counts as unset. The path must be on the `forge_db` volume, that is below
`/data`: a path anywhere else (`file:/tmp/x.db`, a relative path, which
resolves to `prisma/` in the image) would be created by `migrate deploy` in the
container layer, and the next deploy would start from an empty database. In
production (`NODE_ENV=production`, set by the image and `docker-compose.yml`)
`scripts/start.sh` therefore resolves the path (`..`, symlinks in the
directory and a symlink as the file itself are followed) and stops before any
migration when it is not below `/data`, or when `/data` is not a mount point
according to `/proc/self/mountinfo`. The message names the path, the volume and
the override. `FORGE_ALLOW_DATABASE_OUTSIDE_VOLUME=1` (exactly `1`) starts
anyway with a warning, for a deliberate path outside the volume;
`FORGE_DB_VOLUME_DIR` names another mount directory if you mount the volume
somewhere other than `/data` (its path must contain no whitespace or backslash,
which `/proc/self/mountinfo` escapes; the start refuses such a path). Where
`/proc/self/mountinfo` cannot be read, the mount point check is skipped with a
warning. Outside production (local runs) the check does not run. Precedence, highest first:

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

`forge_db` is a named volume, so compose prefixes it with the project name.
`docker-compose.yml` pins that name with a top-level `name: project-forge`, so
the volume is `project-forge_forge_db` whatever the checkout directory is
called (the relay runs `docker compose -f docker-compose.yml` with no `-p`).
The pin is the name the production volume already had, so it changed nothing
for it. A `-p` flag or `COMPOSE_PROJECT_NAME` (also when set in `.env`) still
wins over the pin: with one of them set to another value, the first deploy
starts on a new, empty volume while the old one keeps the data with nothing
pointing at it. Check with `docker volume ls | grep forge_db` before and after
the first deploy after such a change: a second `forge_db` under a different
prefix means the data did not come along. Before the pin existed, moving or
re-cloning the checkout under another directory name had the same effect.

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
- `NEXTAUTH_URL` is checked the same way when the production server starts. On
  deploys through agent-relay or deploy-panel (override not loaded) it must be
  in `.env`, like `NEXTAUTH_SECRET`. The check refuses only what NextAuth
  cannot use: a missing or empty value, the placeholder host
  `your-forge.example.com` from `.env.example` and the override example, or a
  value NextAuth fails to parse (`https://`, a leading space, a trailing
  `# comment`); the refusal is the same as above
  (`Refusing to serve: NEXTAUTH_URL ...`). The check tolerates a host without a
  scheme (`forge.example.com`) and a missing value when `AUTH_TRUST_HOST` or
  `VERCEL` is set (an empty `VERCEL` counts as set and disables that fallback),
  so a running instance is not taken down by them. Sign-in still needs the full
  `https://` URL: the middleware looks for the session cookie under the name
  NextAuth derives from an `https://` `NEXTAUTH_URL`, so with either of those
  setups `/dashboard`, `/create` and `/settings` keep redirecting to `/login`.

### Health check and logs

The `app` service has a compose healthcheck against `GET /api/health`, a
public route that answers `{"ok":true}` without touching the database. It
gives the container 60 seconds to run `scripts/start.sh` (`prisma migrate deploy`,
plus the pre-migrate copy when a migration is pending) and start, probing every
2 seconds during that time (`start_interval`, which needs Docker Engine 25 or
newer and a Compose release that knows the key; the floor for this stack is
Docker Compose v2.24.0, the release that added `required:` support to
`env_file`) so the container turns healthy
soon after the server listens, then every 15 seconds; five failures in a row
mark it `unhealthy` (`docker compose ps`). Because the check reads the route, a server that
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

Labels and `ports` set in the override apply only to runs that load it: deploys
through deploy-panel and agent-relay skip the override entirely (see
[Docker Compose](#docker-compose)), so such a deploy keeps the `Host(...)` rule
of `docker-compose.yml` and publishes no host port. Set your own labels in the
tracked compose file of your fork, or deploy with the override (`make deploy`,
or plain `docker compose`).

### Session cleanup

Generated sessions live in `FORGE_TEMP_DIR` (`/tmp/project-forge` on the
`forge_tmp` volume). That container path is fixed in `docker-compose.yml` on
purpose: the volume is mounted at `/tmp/project-forge` and the hourly prune
(see [Backup and restore](#backup-and-restore)) cleans exactly that path, so
setting `FORGE_TEMP_DIR` in `docker-compose.override.yml` would leave the
volume and the prune pointing at the old path. There is no background
cleanup: an expired session is removed only when it is read again, and a
published one right after the push.
Sessions that are never previewed or published stay on the volume, together
with any uploaded documents, and the `forge_tmp` volume grows until someone
prunes it. This is an operator step, not something the stack does. Prune
periodically, for example:

```bash
docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} +
```

`make install-cron` puts this prune (hourly), the nightly backup and the
daily freshness check that follows it one hour later into the crontab, see
[Backup and restore](#backup-and-restore). The command itself,
without the log redirection the installer appends (hourly, from the checkout
that holds `docker-compose.yml`), is:

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
| File missing, and nothing of a database in its directory | `prisma migrate deploy` creates the schema. No copy. |
| File missing, but its directory holds files that a database leaves behind (another database file, a `-journal`, `-wal` or `-shm` file, a copy of a database) | Abort before anything else: no new database, no `migrate deploy`, nothing changed. The message names the path and the files it found. Fix the path, or create a new database on purpose with `FORGE_ALLOW_NEW_DATABASE=1`. See [No database file at the path](#no-database-file-at-the-path). |
| File missing, and the directory of its path does not exist | Abort before anything else: nothing created, no `migrate deploy`. The message names the path and points at a likely typo in `DATABASE_URL`. Create the directory and a new database on purpose with `FORGE_ALLOW_NEW_DATABASE=1`. An existing, empty directory (a fresh volume) is a first install. See [No database file at the path](#no-database-file-at-the-path). |
| File of 0 bytes, and its directory holds files that a database leaves behind (the same files as for a missing file) | Treated like a missing file: abort, nothing changed, no `migrate deploy`, unless `FORGE_ALLOW_NEW_DATABASE=1`. See [No database file at the path](#no-database-file-at-the-path). |
| File of 0 bytes, nothing of a database next to it | `prisma migrate deploy` creates the schema. No copy. |
| File with bytes, no table in it | `prisma migrate deploy` creates the schema. No copy. |
| Has `_prisma_migrations` and a migration recorded as failed (started, never finished, not rolled back) | Abort before anything else: no copy, no `migrate deploy`, nothing changed. The message names the migration, its start time and the copy to restore. See [A migration failed halfway](#a-migration-failed-halfway). |
| Has `_prisma_migrations` and `prisma/migrations/` holds a dot-directory, a symlink or a directory without `migration.sql` | Abort before the pending check: no copy, no `migrate deploy`, nothing changed. The message names the entry; remove it or add the missing file. |
| Has `_prisma_migrations`, nothing pending | `migrate deploy` (a no-op). No copy. |
| Has `_prisma_migrations`, a migration is pending | A new copy of the file, then `migrate deploy`, unless three copies are already newer than the newest applied migration (see [Pre-migrate copy](#pre-migrate-copy)): then abort, no copy, no `migrate deploy`. |
| Has tables but no `_prisma_migrations` (created by the old `db push` start) and equals `prisma/schema.prisma` | A new copy of the file, mark the baseline migration as applied (`migrate resolve --applied`), then `migrate deploy`. |
| Has tables but no `_prisma_migrations` and differs from `prisma/schema.prisma`, or the comparison fails | Abort. Nothing is changed, the server does not start. |

Pending means: a directory in `prisma/migrations/` of the image being started
(with a `migration.sql`) that has no applied row in `_prisma_migrations`;
applied is a row with `finished_at` set and `rolled_back_at` empty. The script
reads this with `sqlite3` and does not ask `prisma migrate status`: prisma 5.22
reports a migration marked rolled back as up to date and `migrate deploy` then
applies it again. So a migration marked rolled back (`migrate resolve
--rolled-back`), one that finished and was marked rolled back later, and one
that sorts before the newest applied migration are all pending, which is what
`migrate deploy` applies for each of these states (checked with prisma 5.22).
Rows of migrations the image does not have, such as the ones a newer release
applied before the code was rolled back, are not looked at: `migrate deploy`
ignores them, and an older release would otherwise copy the file on every start.

The set matches what `migrate deploy` applies only while every entry of
`prisma/migrations/` is either a regular file (`migration_lock.toml`) or a
plain directory with a `migration.sql`. Prisma 5.22 reads every directory entry,
dot-directories included (it applies a `.name/migration.sql`), leaves symlinks
out, and fails with `P3015` on a directory without `migration.sql`; the script
globs the directory without dot entries and follows symlinks. So a start on a database with migration history with a dot-directory, a
symlink or a directory without `migration.sql` in `prisma/migrations/` stops before it computes anything ("nothing was changed"),
rather than risk a deploy that applies a migration the script did not copy for.
The committed migrations never look like that; it can only come from a
hand-edited image or volume mount.

Any failure of the copy, the check, the resolve or the deploy ends the start
with a non-zero exit and the server is not started. Nothing falls back to
`db push`. Compose restarts the container (`restart: unless-stopped`), so a
failure shows up as a restart loop and an `unhealthy` container; read it with
`docker compose logs app`. A deploy tool that rolls back on a failed health
check (`rollback: true` in `.relay.yml`) puts the previous code back; see
[Rollback](#rollback) for what that does not undo.

### No database file at the path

A missing database file is a first install only when nothing of a database
lies next to it. A typo in `FORGE_DATABASE_URL`, a volume mounted at another
place or a restore under another name also leaves no file at the path, and an
empty database created there starts an instance that looks healthy and has no
data. So before it creates a database, the start looks at the regular files in
the database's directory (dot files included, subdirectories and dangling
symlinks not) and stops when it finds one of these:

- another database file: `*.db`, `*.sqlite`, `*.sqlite3`;
- a SQLite side file: `*-journal`, `*-wal`, `*-shm`;
- a copy of a database: a pre-migrate copy of any database (`*.pre-migrate-*`,
  stamped or not), any other `<name>.db.<suffix>` (such as the
  `.manual-<timestamp>` copy and the `.restore` file this guide uses), and the
  temporary copies that a killed start (`*.tmp-pre-migrate.*`) or a killed
  `scripts/backup.sh` (`*.tmp-backup.*`) leaves behind. Both are only ever
  written from an existing database.

A database file of 0 bytes counts as missing for this check: with one of the
files above next to it, the start stops the same way (the message then says
"the database file at ... is empty (0 bytes)") instead of putting an empty
schema into it. A 0-byte file with nothing of a database next to it is a first
install and is initialised, and so is a file with bytes but no table. A new,
empty volume (an existing, empty directory) is a first install too.

A path whose directory does not exist stops the start as well, before the
check above: a new volume is an existing directory (its mount point), so a
missing directory is most likely a typo in the directory part of
`FORGE_DATABASE_URL`, and prisma would otherwise create the directories and an
empty database in the wrong place. The message names the path:

```
[db-start] ERROR: the directory /dta/ of the database path /dta/project-forge.db does not exist (or is not a directory). No database was created and nothing was changed. This is most likely a typo in DATABASE_URL (FORGE_DATABASE_URL in .env for the compose stack); a new volume is an existing, empty directory and does not look like this. Fix the path, then start again. To create the directory and a new, empty database at /dta/project-forge.db on purpose, start once with FORGE_ALLOW_NEW_DATABASE=1 (it is unset or empty now). See docs/deployment.md, section "Database migrations".
```

When it finds one of the files above, it creates nothing, runs no
`migrate deploy`, and names the path and the files:

```
[db-start] ERROR: no database file at /data/project-forge.db, but /data/ holds files that a database leaves behind: project-forge.db.pre-migrate-20261027T132758Z, project-forge.db.restore. No database was created and nothing was changed. Check DATABASE_URL (FORGE_DATABASE_URL in .env for the compose stack): a typo, a volume mounted at another place or a restore under another name looks like this. Fix the path or put the database file back, then start again. To create a new, empty database at /data/project-forge.db on purpose, start once with FORGE_ALLOW_NEW_DATABASE=1 (it is unset or empty now); creating it discards a /data/project-forge.db-journal or /data/project-forge.db-wal left under that name, so move them away first if the old database may need them. See docs/deployment.md, section "Database migrations".
```

Usually the path is wrong: check `FORGE_DATABASE_URL` (see
[Database location](#database-location)) and the `forge_db` mount, or finish
the restore, and start again. A directory with none of these files is a first
install and the start creates the database as before. A database file that
exists with bytes, with or without tables, is not affected.

Look at the directory with `ls`, not with `sqlite3`:
`docker compose run --rm --no-deps app ls -la /data/`. `sqlite3` on a path
that does not exist creates an empty, 0-byte file there, even when its
statement fails. If `ls -l` shows such a 0-byte file at the database path, delete it
before the next start. If you do not, a start with other database files next
to the 0-byte file stops as described above; a 0-byte file alone in the
directory is initialised.

To create a new, empty database at that path on purpose, set
`FORGE_ALLOW_NEW_DATABASE=1` for one start. Only the exact value `1` allows
it; unset, empty, `0`, `true`, `yes` and every other value do not. The start
then logs a warning that names the files it found and creates the database.
start.sh moves or deletes none of them, but SQLite discards a `-journal` or
`-wal` of the same name when it creates the file (checked with sqlite3 3.54 and
prisma 5.22 `migrate deploy`; prisma leaves its own zero-filled `-journal` (a few KiB, harmless) behind),
so move those away first if the old database may still need them. The
variable matters only while the file is missing or has 0 bytes, or while the
directory of the path is missing. The simplest way is a one-off
container, which does not keep the setting; stop the restarting `app` first,
so that no second start works on the same new file:

```
docker compose stop app
docker compose run --rm --no-deps -e FORGE_ALLOW_NEW_DATABASE=1 app sh scripts/start.sh true
docker compose up -d app
```

The `app` container also reads it from `.env` (`env_file`). If you set it
there instead, remove the line again once the database exists and recreate the
container (`docker compose up -d app`), so that a later lost path stops again
instead of starting empty.

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

Every start that is about to change an existing database file writes a new
copy of it first: before `migrate deploy` whenever a migration is pending, and
before the baseline is recorded. The copy is
`<database file>.pre-migrate-<UTC timestamp>` in the same directory, which is
`/data/project-forge.db.pre-migrate-20261027T132758Z` on the `forge_db` volume
by default; a second copy within the same second gets `-1`, the next `-2`, and
so on. The copy is made with `sqlite3 .backup` (the runner image installs
`sqlite3`), so it is consistent, and the file mode is `600` because the
database holds password hashes and GitHub tokens. It is a full-size copy on the
same volume: check the free space before a large deploy. If the copy cannot be
written, the start aborts before anything is changed.

A start with nothing pending makes no copy. A start that finds a failed
migration makes none either (see below), so the restart loop after a migration
that fails halfway does not add copies. Otherwise there is no deduplication:
every start with a pending migration copies, also when the file has not changed
since the last one, and also when the `migrate deploy` that follows then fails
without recording anything.

That last case is bounded. A deploy can fail before prisma writes a row: the
database is write-locked by another process, prisma rejects an entry in
`prisma/migrations/`, or prisma dies early. There is no failed row for the next
start to find, so every restart would write another full copy. Before a copy,
the script counts the stamped copies whose stamp second is later than the
newest `finished_at` of an applied row in `_prisma_migrations` (applied: set
`finished_at`, empty `rolled_back_at`; with no applied row at all, every stamped
copy counts). Three or more end the start without a copy, without
`migrate deploy` and with nothing changed:

```
[db-start] ERROR: deploy keeps failing before it records a migration (3 copies since the last applied migration); nothing was changed. No new copy was taken and migrate deploy was not run. Find the cause in the output of the earlier starts (for example a locked database or a migration prisma rejects), fix it, then remove all but one of the copies stamped after the newest applied migration (older copies do not count) and start again. A database restored from an older copy leaves the later copies counting: move them to a name outside the .pre-migrate- prefix. See docs/deployment.md, section "Database migrations".
```

So the container takes at most three copies before it stops, in the history branch and in the baseline of a `db push` database alike (there every stamped copy counts, since no migration is applied yet; a `migrate resolve` that keeps failing on a write-locked file ends the same way). A database restored from an older copy has later copies stamped after its newest applied migration, so they count too: move them to a name outside the prefix before the next start (a full-size copy
each: the free space for three is the worst case), and the restart loop after
that costs no disk. To clear the stop, read the output of the earlier starts
(`docker compose logs app`) and fix the cause, then remove all but one of the copies stamped after the newest applied
migration (the ones the message counts; older copies, restore points of earlier
deploys, do not count and can stay) with the `rm` command below; the
copies normally hold the same state, because a deploy that records nothing
has not changed the file. The count also drops to zero when a migration is applied: its
`finished_at` is later than the copies. A copy in the same second as that
`finished_at` is not counted. The failed-migration stop comes first: with a
failed row, the start reports that and never looks at the count. Copies you
keep for another reason still count while their stamp is later than the newest
applied migration; move them to a name outside the prefix to take them out.

Finding the right copy: the stamp is the UTC time the start took it, right
before its `migrate deploy`. The copy from before a migration is the newest one
whose stamp is not later than that migration's `started_at` in
`_prisma_migrations`; after a failure the start finds and names it for you.
The start only counts names of exactly the form
`<database file>.pre-migrate-YYYYMMDDTHHMMSSZ`, optionally followed by `-<n>`.
Do not use the `.pre-migrate-` prefix for copies of your own: the start
ignores them when it picks the copy to restore, and among the real copies they
are easy to mistake for one. Use another name, such as
`/data/project-forge.db.manual-<timestamp>`.

Nothing deletes the copies. Every start logs, before it looks at the database,
how many there are and how much space they take:

```
[db-start] pre-migrate copies in /data/: 3, 1.2 GiB in total
```

The line counts every file that the `ls` command below lists
(`*.pre-migrate-*` in the database's directory, stamped or not); a copy whose
size cannot be read is counted and named in the line, and the start goes on.
With more than `FORGE_PRE_MIGRATE_COPIES_WARN` copies the start also warns,
and goes on:

```
[db-start] WARNING: 6 pre-migrate copies in /data/ (2.4 GiB in total), more than 5 (FORGE_PRE_MIGRATE_COPIES_WARN). Each is a full copy of a database on the same volume and nothing deletes them: remove the ones you no longer need. See docs/deployment.md, section "Database migrations".
```

`FORGE_PRE_MIGRATE_COPIES_WARN` is read from `.env` (the `app` service loads
it with `env_file`). Unset or empty means 5, which is above the three copies a
stopped restart loop leaves (see above), so that alone does not warn; `0`
warns whenever a copy exists. Any value other than a whole number from 0 to
999999999 gets a warning that names it, and the default 5 applies; the knob
never stops a start. Removing copies stays an operator step. List and remove them once the new version has
run well:

```
docker compose run --rm --no-deps app sh -c 'ls -l /data/*.pre-migrate-*'
docker compose run --rm --no-deps app sh -c 'rm /data/project-forge.db.pre-migrate-<timestamp>'
```

To go back to a copy: `docker compose stop app`, then copy it next to the
database under a temporary name, remove the `-journal`, `-wal` and `-shm` files
of the database (a leftover one belongs to the file you are replacing and would
be applied to the copy), and move the temporary file into place. If the copy
fails, for example on a full disk, nothing has been removed yet. The file you
replace is gone afterwards; copy it away first, under a name outside the
prefix, if you want to keep it.

```
docker compose run --rm --no-deps app sh -c 'set -e; cp /data/project-forge.db.pre-migrate-<timestamp> /data/project-forge.db.restore; rm -f /data/project-forge.db-journal /data/project-forge.db-wal /data/project-forge.db-shm; mv /data/project-forge.db.restore /data/project-forge.db'
```

### A migration failed halfway

Prisma applies a migration's statements one after the other and, on SQLite,
does not undo the ones that already ran when a later statement fails. The
migration then stays in `_prisma_migrations` as failed (no `finished_at`, no
`rolled_back_at`) and the database is partly migrated. Checked with prisma
5.22: a migration that adds a column and then fails leaves the column in the
file, and `migrate deploy` refuses to continue (`P3009`) until the failed
migration is resolved.

What the start does:

1. The first start with the pending migration takes the pre-migrate copy (the
   file as it was before the migration), runs `migrate deploy`, which fails, and
   exits with `prisma migrate deploy failed` naming that copy.
2. Every later start (the restart loop) finds the failed row before it looks
   for pending migrations and before any copy, and stops. It takes no new copy,
   because a copy of the half-migrated file would look like a restore point and
   is not one, and it does not run `migrate deploy`. The log names the
   migration, its start time (UTC) and the newest pre-migrate copy that is not
   newer than that start, which is the copy from step 1:

```
[db-start] ERROR: migration 20261028000000_add_nick failed halfway (recorded in _prisma_migrations since 20261027T140939Z, UTC) and was never rolled back. SQLite keeps the statements that ran before the error, so /data/project-forge.db may be partly migrated. The server was not started, no new copy was taken and migrate deploy was not run. Stop the container, restore /data/project-forge.db.pre-migrate-20261027T140938Z (the newest pre-migrate copy taken before that migration started) and remove /data/project-forge.db-journal, /data/project-forge.db-wal and /data/project-forge.db-shm, then deploy a fixed migration or the previous release. See docs/deployment.md, section "Database migrations".
```

When other rows of `_prisma_migrations` started after that copy (in its
second or later), the message adds `Warning: _prisma_migrations also has rows
that started after that copy was taken (<names>), so the copy may predate later
changes.` A migration that the same start applied before the one that failed
is applied again by the next start after the restore. A migration applied or
resolved by hand after the copy is undone by the restore. Look at the rows
before you restore:
`docker compose run --rm --no-deps app sqlite3 /data/project-forge.db 'SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at'`
(`started_at` is in milliseconds since 1970, UTC).

When no copy is older than the start, the message says so. If the start that
ran the failed migration created the database (there was no database file, or
one without tables, so that start took no copy), stop the container, delete
the database file with its `-journal`, `-wal` and `-shm` files and fix the
migration: the next start creates the database again, unless other database
files lie next to it; then start once with `FORGE_ALLOW_NEW_DATABASE=1`, see
[No database file at the path](#no-database-file-at-the-path). Otherwise (the migration
ran outside this start script, or the copies were deleted) restore your own
backup.

Recovery:

1. `docker compose stop app`.
2. Restore the copy the message names, with the command under
   [Pre-migrate copy](#pre-migrate-copy). When the failed migration ran in a
   start of this script, that start took the copy right before its
   `migrate deploy`, and no server ran in between, so the copy holds
   everything written before that start. If the message carries the warning,
   check the rows it names first.
3. Fix the migration (or deploy the previous release). The restored file has no
   failed row, so nothing needs `prisma migrate resolve`: the next start sees
   the migration as pending and applies it, with the usual copy step.
4. `docker compose up -d app`.

Repairing in place instead of restoring is possible when you know exactly what
the failed migration did: undo or finish its statements by hand, then run
`prisma migrate resolve --rolled-back <name>` (the migration is applied again
at the next start) or `--applied <name>` (it is marked as done and nothing is
run). Take your own copy of the file before the hand repair, under a name
outside the prefix:
`docker compose run --rm --no-deps app sh -c 'umask 077; sqlite3 /data/project-forge.db ".backup /data/project-forge.db.manual-<timestamp>"'`.
After `--rolled-back` the migration is pending again, so the next start writes
a new pre-migrate copy before it applies the migration, and if the migration
fails once more, the restart names that new copy (checked with prisma 5.22,
whose `migrate status` calls this state up to date).

### Rollback

`rollback: true` in `.relay.yml` and a manual `docker compose up` of an older
checkout both change the code only. They do not undo a migration: the database
keeps the schema the newer release gave it.

- **An older release with migrations** (this one or later) starts on a
  database that has newer migrations: `migrate deploy` ignores migrations it
  does not know (checked: baseline-only release on a database with a later
  column, `Database schema is up to date!`). The older code then runs on the
  newer schema, which is fine for additive changes and can fail for a
  contracting one.
- **Never start a release that still ran `prisma db push` (0.8.0 and earlier)
  on a database that has any migration after the baseline.** `db push` compares
  the file with its own, older schema and drops what that schema does not
  know. Columns, tables and indexes without data are dropped with exit 0 and no
  prompt (checked with prisma 5.22: a nullable column added by a later migration
  was gone after `db push`). `_prisma_migrations` still lists the migration,
  so starting the newer release again says `up to date`, applies nothing and
  runs on a schema that lacks the column. An object that holds data makes
  `db push` stop and ask for `--accept-data-loss` instead. Either way, the way
  back to a `db push` release is the pre-migrate copy from before the first
  migration after the baseline (restore it as described above), not the current
  file. A database that has only the baseline matches the old schema, and
  `db push` leaves it alone.

A rollback of the code alone leaves the database where it is. If you want the
data of an older point too, restore a backup taken at that point with
[Backup and restore](#backup-and-restore); remember that a restore drops
everything written since that backup, so for undoing only the last migration
the pre-migrate copy from just before it is the better restore point.

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
- A migration that fails halfway leaves the statements that ran and a failed
  entry in `_prisma_migrations`; every later start stops. Recovery is in
  [A migration failed halfway](#a-migration-failed-halfway): restore the
  pre-migrate copy the log names, fix the migration, start.

## Backup and restore

`scripts/backup.sh` takes a routine snapshot of the production database to the
host, outside the `forge_db` volume, and rotates the old snapshots. Run it on
the deploy host, from the checkout that holds `docker-compose.yml` (so the
same compose file and `.env` apply):

```bash
make backup            # or: sh scripts/backup.sh
```

What it does: it reads the database path from the running `app` container
(`docker compose exec -T app printenv DATABASE_URL`), never from the compose
file, so a `FORGE_DATABASE_URL` override or an override-file path is picked up
automatically; takes a consistent copy inside the container with
`sqlite3 <db> ".backup <tmp>"` (never a `cp` of the live file, the same method
as the [pre-migrate copy](#pre-migrate-copy)); checks the copy with
`PRAGMA integrity_check` and refuses to publish anything unless it says `ok`;
copies it out with `docker compose cp` and publishes it atomically (temporary
name, then `mv`) as `project-forge-<UTC stamp>.db` with mode 600, because the
database holds password hashes and GitHub tokens. Every failure exits
non-zero and publishes nothing, and the temporary file inside the container
is removed on every path. This needs an image built after `sqlite3` was added
to the runner image (the same build `scripts/start.sh` needs): on an older
image the copy step fails with a non-zero exit and nothing is written.

The output goes to `FORGE_BACKUP_DIR`, default `$HOME/project-forge-backups`,
which is deliberately outside the checkout (the deploy tree must stay clean).
Environment knobs: `FORGE_BACKUP_DIR` (an explicit directory wins; unset or
empty means the `$HOME` default), `FORGE_BACKUP_KEEP` (how many files to keep,
default 14; unset or empty means 14, zero or anything non-numeric is refused
before anything runs) and `COMPOSE_FILE` (left in the environment for
`docker compose` to read itself, its `:` list format included, so a non-default
compose file is selected the usual way). Rotation keeps the newest
`FORGE_BACKUP_KEEP` files whose name is exactly
`project-forge-YYYYMMDDTHHMMSSZ.db` (or with the `-<n>`
suffix of a second run in the same second) and never touches anything else in
the directory; the names never use the `.pre-migrate-` prefix that belongs to
[start.sh](#pre-migrate-copy), so the two mechanisms cannot confuse each
other.

Schedule it, the hourly `forge_tmp` prune, and the daily freshness check that
flags a backup that did not run, with one command on the deploy host (it edits
the crontab of the invoking user):

```bash
FORGE_BACKUP_DIR=/var/backups/project-forge make install-cron
make install-cron ARGS=--dry-run    # print the block, change nothing
make install-cron ARGS=--remove     # delete the block, nothing else
```

`scripts/install-cron.sh` writes one marked block (`# BEGIN project-forge ...`
to `# END project-forge`) holding the three entries, with absolute paths taken from
the checkout the script lives in. A re-run replaces that block in place and
leaves every other crontab line untouched; a re-run that changes nothing does
not call `crontab` at all. The block keeps the absolute paths of the checkout
it was installed from. After moving or re-cloning the checkout somewhere
else, run `make install-cron` again from the new checkout (with the same
`FORGE_BACKUP_DIR`) and check with `crontab -l` that the block names the new
path: until you do, all three entries `cd` into the old path first, so the
hourly prune, the nightly backup and the freshness check all fail quietly: the
`cd` fails, the command never runs and nothing reaches the log (cron only mails
the error, if mail is set up). `FORGE_BACKUP_DIR` is required and must be an
absolute path (cron's `HOME` is the crontab owner's, so the default of
`backup.sh` is not trusted there); unset or empty is refused. Optional:
`FORGE_BACKUP_TIME` (`HH:MM`, default `03:15`) and `FORGE_BACKUP_LOG` (default
`$FORGE_BACKUP_DIR/cron.log`, shared by all three entries). A path with a single
quote or a `%` is refused. A hand-made crontab line for the same job is not
recognised: remove it before installing, or the backup runs twice.

`make install-cron` also creates `FORGE_BACKUP_DIR` and the directory of the log
file (mode 700) and touches the log, because all three entries redirect into it
and a missing directory would make cron skip them silently; it refuses if the log
cannot be written. Cron runs with a minimal `PATH` (often `/usr/bin:/bin`), and
the prune and backup entries call `docker`: if it lives elsewhere, add a
`PATH=...` line above the block with `crontab -e` (lines outside the block are
never touched) or make `docker` reachable from `/usr/bin`.

Without make, the raw entries the block writes (with the default time and log,
`FORGE_BACKUP_DIR=/var/backups/project-forge`) are, after creating that
directory yourself:

```cron
0 * * * * cd '/path/to/project-forge' && docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} + >> '/var/backups/project-forge/cron.log' 2>&1
15 3 * * * cd '/path/to/project-forge' && FORGE_BACKUP_DIR='/var/backups/project-forge' sh ./scripts/backup.sh >> '/var/backups/project-forge/cron.log' 2>&1
15 4 * * * cd '/path/to/project-forge' && FORGE_BACKUP_DIR='/var/backups/project-forge' sh ./scripts/backup.sh --check-fresh 2 >> '/var/backups/project-forge/cron.log' 2>&1
```

Whether backups still run: after every successful, verified backup
`backup.sh` replaces `$FORGE_BACKUP_DIR/.last-success` (temporary file, then
`mv`) with one line, the UTC time and the file name of that backup. A failed
run never writes it, so its modification time is the last real success.
`sh scripts/backup.sh --check-fresh [hours]` needs no container and exits 0
when the stamp is younger than that many hours (default 26, a nightly run plus
slack; a positive integer without a leading zero, at most 6 digits) and 1 when
it is missing, empty or older (the reason goes to stderr).

`install-cron.sh` schedules that check for you, as the third entry of the
block: a daily run one hour after the backup time (`03:15` is checked at
`04:15`, a `23:30` backup at `00:30`) calling `--check-fresh 2`. One hour
after a successful backup the stamp is about an hour old and the entry exits
0; after a backup that did not run (or failed) it is about 25 h old, so the
stale reason lands in the same cron log as the backup output the same night.
The threshold must stay above the backup's run time plus slack and below 24,
so a backup that takes longer than about an hour would be reported stale.
Cron local-time shifts (a DST change) move both entries together, so the
one-hour gap is stable. A monitoring probe outside cron can still call the
very same command with the default 26 h and alert on its non-zero exit, for
example `FORGE_BACKUP_DIR=/var/backups/project-forge sh ./scripts/backup.sh --check-fresh 26`.
The entries redirect their output into the log (`>> ... 2>&1`), so cron mails
nothing about them: to get cron mail for one instead, drop its redirect with
`crontab -e`.

Copying the backups to another machine is not automated here, see below.

A backup inside the volume's host is no backup at all: copy the directory to
another machine as part of your routine, for example
`rsync -a --delete /var/backups/project-forge/ backuphost:/backups/project-forge/`.
The files carry the same secrets as the database, keep the mode 600 and the
destination readable by the operator only.

### Disk space

Every deploy builds the image again (`docker compose up -d --build`, in
`make deploy` and `make pull`; relay deploys rebuild too when the code
changed, see [Docker Compose](#docker-compose)). Docker never removes what the rebuilds
leave behind: each one turns the previous image of the service into a dangling
one and grows the BuildKit build cache, so the host disk fills up over time.
`.relay.yml` has no prune step, so this is an operator task. See the usage
with:

```bash
docker system df
```

Remove the dangling images, and the build cache older than a week:

```bash
docker image prune -f
docker builder prune -f --filter until=168h
```

Both commands act on the whole Docker host, not only this stack. Dangling
images and build cache older than a week are normally safe to drop, but on a
host shared with other apps their next builds get slower; check
`docker system df` first.

Never reclaim space with `docker system prune --volumes`: depending on the
Docker version (older releases, or newer ones with `--all`) it also deletes
named volumes that no running container uses, and while the stack is stopped
that includes `forge_db`, the database. It must not be used on this host.

Never take the stack down with `docker compose down -v` or `docker compose
down --volumes`: these delete the project's named volumes, `forge_db` with
the database and `forge_tmp` with the temporary generation and preview
sessions, and the next start finds an empty volume and silently
creates a fresh, empty database on it (the first-install row of the table in
[Database migrations](#database-migrations)). For maintenance use
`docker compose down` without `-v`, or `docker compose stop` /
`docker compose up -d`.

### Restoring a backup

A restore puts the database back to the moment of the backup: every write
after it (users, API tokens, sessions, published-project rows) is gone. That
includes what the app wrote while the backup was being taken. Restore with the
app stopped, so nothing writes between the check and the swap: stop it with
`docker compose stop` or `docker compose stop app`, never with
`docker compose down -v` (see [Disk space](#disk-space)), which would delete
the volume the restore writes into:

1. Stop the app: `docker compose stop app`.
2. Stream the backup onto the volume under a temporary name. Do not use
   `docker compose cp` for this: it keeps the host file's owner (your uid) and
   mode, and the app container runs as root with every capability dropped
   (`cap_drop: ALL`, so no `DAC_OVERRIDE`), which means root can neither read
   nor change a mode 600 file owned by another uid. Reading from stdin makes
   the container create the file itself, as root with mode 600 (adjust both
   paths if `FORGE_DATABASE_URL` points elsewhere than `/data/project-forge.db`):
   `docker compose run --rm -T --no-deps app sh -c 'set -e; rm -f /data/project-forge.db.restore; umask 077; cat > /data/project-forge.db.restore' < /var/backups/project-forge/project-forge-<timestamp>.db`
3. Check the file and replace the database with it, dropping the journal side
   files of the file you are replacing (a leftover `-wal` belongs to the old
   database and would be applied to the restored one). The runner image has no
   `USER`, so the app runs as root (a non-root user is not used yet: the
   production `forge_db` volume is root-owned and would need a migration), but
   with `no-new-privileges` and every Linux capability dropped, so it gains no
   privilege after start; root ownership with mode 600 is what the app expects,
   and step 2 already created the file that way:
   `docker compose run --rm --no-deps app sh -c 'set -e; chmod 600 /data/project-forge.db.restore; [ -s /data/project-forge.db.restore ]; [ "$(sqlite3 /data/project-forge.db.restore "PRAGMA integrity_check")" = ok ]; [ "$(sqlite3 /data/project-forge.db.restore "SELECT count(*) > 0 FROM _prisma_migrations")" = 1 ]; rm -f /data/project-forge.db-journal /data/project-forge.db-wal /data/project-forge.db-shm; mv /data/project-forge.db.restore /data/project-forge.db'`
   The `chmod` and three checks run first: the restore file is not empty,
   SQLite's integrity check says `ok`, and it holds the app's migration
   history (an empty file passes the integrity check on its own, and the next
   start would turn it into an empty instance). So an empty, damaged, unreadable
   or foreign restore file stops the step before the live database is touched.
   If this step fails before the last command (the `mv`), the old database
   file is still in place and the restore file is still named `.restore`; only
   a `-journal` left by a crash is gone by then (step 1 stops the app cleanly,
   so normally there is none). Fix the cause and run the step again.
4. Start the app: `docker compose up -d app`.
5. Check it came back healthy: `docker compose ps` must show `healthy` (the
   healthcheck probes `/api/health`; `docker compose logs app` shows the
   start), log in or hit a real route to confirm the data, and prove the
   database is writable, because health stays green on a read-only database:
   `docker compose exec -T app sqlite3 /data/project-forge.db 'BEGIN IMMEDIATE; CREATE TABLE _write_check(x); ROLLBACK;'`
   must exit 0 and print nothing (it creates nothing; "attempt to write a
   readonly database" means the file has the wrong owner or mode, so stop and
   redo steps 2 and 3).

The restored file carries whatever `_prisma_migrations` held at backup time.
If the code you are running has newer migrations, the next start applies them
again with its usual pre-migrate copy. If it is older than the restored
schema, do not start it (see [Rollback](#rollback)).

## Upgrading to committed migrations

The release that adds `prisma/migrations/` replaces the container's
`prisma db push` with `scripts/start.sh` (see [Database migrations](#database-migrations)).
If you take the stack down during this upgrade, never use
`docker compose down -v`: it deletes `forge_db`, the database (see
[Disk space](#disk-space)).
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
sed -i.bak "s/^PLANFORGE_SERVICE_TOKEN=.*/PLANFORGE_SERVICE_TOKEN=$NEW_TOKEN/" .env && rm .env.bak
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
  (`FORGE_DATABASE_URL` for the database path). Override keys with no `.env`
  counterpart cannot move there: the Traefik labels (the `Host(...)` router
  rule, the entrypoint, the certificate resolver) and `ports` under `app` stay
  the ones of `docker-compose.yml` on such deploys: the upstream `Host(...)`
  rule and no published host port. Set your own in the tracked compose
  file of your fork (see [Routing](#routing)).
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
and still work, but step 6 does not hold when you upgrade from a version
before 0.7.0 straight to a release with migrations. After step 5 the file
still differs from `prisma/schema.prisma`: expand adds `tokenHash` and
`tokenPrefix` as nullable columns, the schema says `NOT NULL`, so the new start
reports `Redefined table ApiToken`, aborts and does not baseline (checked with
prisma 5.22; the old `db push` start tightened the table on its own, the new
start never changes a table). Between step 5 and step 6, do one of these:

- Apply the difference with the new image. Read it first:
  `docker compose run --rm --no-deps app sh -c 'node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script'`
  (a `RedefineTables` script for `ApiToken`). Then take a copy under a name
  outside the `.pre-migrate-` prefix and apply the script in one transaction,
  so that a row the new table rejects leaves the database as it was:
  `docker compose run --rm --no-deps app sh -c 'set -e; umask 077; sqlite3 /data/project-forge.db ".backup /data/project-forge.db.before-tighten"; node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > /tmp/tighten.sql; { echo "PRAGMA foreign_keys=OFF;"; echo "BEGIN;"; cat /tmp/tighten.sql; echo "COMMIT;"; } | sqlite3 -bail /data/project-forge.db'`
  (adjust the path if `FORGE_DATABASE_URL` is set). Exit 0 and a second
  `migrate diff --exit-code` printing `No difference detected.` means done
  (checked in the image: rows and `UsageLog` kept). A non-zero exit, such as
  `NOT NULL constraint failed: new_ApiToken.tokenPrefix` for a token without a
  prefix, leaves `ApiToken` as it was (checked in the image: exit 1, rows kept,
  no `new_ApiToken` left): fix that row and run the command again.
  `/data/project-forge.db.before-tighten` is the way back; delete it once the
  new version has run well.
- Or start a 0.7.0 or 0.8.0 image (an older checkout) once against the same
  volume: its `db push` redefines `ApiToken` (checked: exit 0, rows kept).

Then step 6 starts the new container, which baselines the file in place of the
old `db push` (see [Database migrations](#database-migrations)).

0.7.0 stores API tokens hashed: `ApiToken.token` is replaced by
`tokenHash` and `tokenPrefix`. At 0.7.0 the container's start command ran
`npx prisma db push --skip-generate` without `--accept-data-loss`, so on a
database that still held plaintext tokens the new container exited at
start-up and did not serve requests. A data migration has to run during
the deploy. The one-off containers below mount the checkout's `scripts/`
directory because the runner image does not ship the backfill script, and the SQLite file
lives on the `forge_db` volume (`DATABASE_URL=file:/data/project-forge.db`,
the default in `docker-compose.yml`).

Run everything from the checkout that holds `docker-compose.yml`,
`docker-compose.override.yml` and `.env`, after pulling 0.7.0. The one-off
containers read the same environment as the `app` service, which is what
makes the hash key below match. Never use `docker compose down -v` (or
`--volumes`) anywhere in this runbook: it deletes `forge_db`, the
database being migrated, see [Disk space](#disk-space).

The `-v ./scripts:/app/scripts` runs below need the checkout's `scripts/`
files to be world-readable (the default for a clone): the app container runs
as root without `DAC_READ_SEARCH`, so it cannot read files only their host
owner may read.

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
6. Start the new container (with migrations: after the tightening above; at
   0.7.0 its `db push` was a clean no-op):
   `docker compose up -d app`

Steps 4 and 5 are the cutover and must not be reordered around step 3:
contract while the old container is live breaks every token-authenticated
request, and starting the new container before contract makes it exit (the
`db push` start refused the plaintext column; the migrations start aborts on
the difference).
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
