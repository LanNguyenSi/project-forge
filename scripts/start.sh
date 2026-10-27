#!/bin/sh
# Container start: bring the SQLite database to the committed schema with
# `prisma migrate deploy`, then exec the server command given as arguments.
#
#   sh scripts/start.sh node_modules/.bin/next start
#
# It never runs `prisma db push`. Decision table (the database path comes from
# DATABASE_URL; a relative `file:` path resolves against prisma/, like Prisma):
#
#   file missing, or file without any table   -> migrate deploy (creates it)
#   _prisma_migrations present, a migration is recorded as failed
#                                             -> abort, nothing changed, no copy
#   _prisma_migrations present, up to date    -> migrate deploy (no-op), no copy
#   _prisma_migrations present, status != 0   -> copy, then migrate deploy
#   tables but no _prisma_migrations (a database that `db push` created):
#       schema equals prisma/schema.prisma    -> copy, mark the baseline migration
#                                                as applied, migrate deploy
#       schema differs, or the check fails    -> abort, nothing changed
#
# The copy is `<db>.pre-migrate-<UTC timestamp>` next to the database file, made
# with `sqlite3 .backup` (consistent even with a journal left by a crash). Any
# failure of the copy, the check, the resolve or the deploy aborts with a
# non-zero status and the server command is not started.
#
# A migration that fails halfway stays in _prisma_migrations as failed (no
# finished_at, no rolled_back_at), and SQLite does not undo the statements that
# ran before the error. The next start finds that row first and stops without
# touching the file: a new copy would be a copy of the damaged database and
# would look like a restore point. The message names the newest pre-migrate
# copy that is older than the failed migration's start, which is the one to
# restore.
#
# Tested in tests/integration/start-script.test.ts with stub `prisma` and `sqlite3`
# binaries (PRISMA_BIN, SQLITE3_BIN) and with the real ones.
set -eu

# The migration that represents the schema of a database created by `db push`.
# tests/integration/start-script.test.ts keeps this in step with prisma/migrations.
BASELINE="20261027000000_baseline"

PRISMA="${PRISMA_BIN:-node_modules/.bin/prisma}"
SQLITE3="${SQLITE3_BIN:-sqlite3}"
SCHEMA="prisma/schema.prisma"
DOCS='docs/deployment.md, section "Database migrations"'

log() { printf '[db-start] %s\n' "$*"; }
die() { printf '[db-start] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$#" -gt 0 ] || die "usage: start.sh <server command> [args...]"

url="${DATABASE_URL:-}"
case "$url" in
  file:*) ;;
  "") die "DATABASE_URL is not set" ;;
  *) die "DATABASE_URL must be a SQLite file: URL" ;;
esac
db="${url#file:}"
db="${db%%\?*}"
[ -n "$db" ] || die "DATABASE_URL has no file path"
case "$db" in
  /*) ;;
  *) db="prisma/$db" ;;
esac
case "$db" in
  *"'"*) die "database path must not contain a single quote: $db" ;;
esac

# The start reads the database state and takes the copy with sqlite3. Checked
# once, before anything else, so that no later step depends on it by accident.
command -v "$SQLITE3" >/dev/null 2>&1 || die "sqlite3 not found (looked for $SQLITE3): it is needed to read the state of $db and to take the pre-migrate copy. Nothing was changed."

copy_note=""

# Runs one sqlite3 query and prints its output. A failure exits the script
# (also when called inside $( ), where the caller adds `|| exit 1`).
query() {
  out=$("$SQLITE3" "$db" "$1") || die "cannot read the SQLite database at $db (not a database, locked or unreadable). Nothing was changed."
  printf '%s\n' "$out"
}

# Same, for a query that must answer with a number.
count() {
  out=$(query "$1") || exit 1
  case "$out" in
    ''|*[!0-9]*) die "unexpected answer from sqlite3 for [$1]: $out" ;;
  esac
  printf '%s\n' "$out"
}

pre_migrate_copy() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ) || die "cannot read the clock for the copy name"
  target="$db.pre-migrate-$stamp"
  n=0
  while [ -e "$target" ]; do
    n=$((n + 1))
    target="$db.pre-migrate-$stamp-$n"
  done
  tmp="$db.tmp-pre-migrate.$$"
  # umask 077: the database holds password hashes and GitHub tokens.
  if ! (umask 077 && "$SQLITE3" "$db" ".backup '$tmp'"); then
    rm -f "$tmp"
    die "could not copy $db before migrating (disk full or read-only volume?). Nothing was changed."
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "pre-migrate copy of $db is empty. Nothing was changed."; }
  # A restart loop must not pile up identical copies: keep the newest one when
  # the database has not changed since.
  latest=$(ls -1 "$db".pre-migrate-* 2>/dev/null | tail -n 1)
  if [ -n "$latest" ] && cmp -s "$tmp" "$latest"; then
    rm -f "$tmp"
    log "database unchanged since $latest, keeping that copy"
    copy_note="pre-migrate copy: $latest"
    return 0
  fi
  mv "$tmp" "$target" || { rm -f "$tmp"; die "could not move the pre-migrate copy into place at $target. Nothing was changed."; }
  log "pre-migrate copy written: $target"
  copy_note="pre-migrate copy: $target"
}

# Stops the start when _prisma_migrations holds a migration that began and
# neither finished nor was marked rolled back. Prisma does not undo the
# statements of a failed SQLite migration, so the file may be half migrated.
# Nothing is copied here (a copy of the damaged file is not a restore point)
# and `migrate deploy` is not run (it refuses on that row anyway).
refuse_failed_migration() {
  row=$(query "SELECT COALESCE(migration_name, '') || '|' || COALESCE(started_at, '') || '|' || COALESCE(CASE typeof(started_at) WHEN 'integer' THEN strftime('%Y%m%dT%H%M%SZ', started_at / 1000, 'unixepoch') ELSE strftime('%Y%m%dT%H%M%SZ', started_at) END, '') FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name LIMIT 1") || exit 1
  [ -n "$row" ] || return 0
  name=${row%%|*}
  rest=${row#*|}
  started_stamp=${rest#*|}
  started_raw=${rest%%|*}
  case "$started_stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) die "cannot read the start time ($started_raw) of the failed migration $name in $db. Nothing was changed. See $DOCS." ;;
  esac
  started_num=$(printf '%s' "$started_stamp" | tr -d TZ)
  best=""
  # Names sort oldest first (UTC stamp, then the -N suffix), so the last one
  # that is not newer than the failed migration's start wins.
  for f in "$db".pre-migrate-*; do
    [ -f "$f" ] || continue
    stamp=${f##*.pre-migrate-}
    stamp=${stamp%%-*}
    case "$stamp" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
      *) continue ;;
    esac
    [ "$(printf '%s' "$stamp" | tr -d TZ)" -le "$started_num" ] && best=$f
  done
  if [ -n "$best" ]; then
    advice="Stop the container, restore $best (the newest pre-migrate copy taken before that migration started) and remove $db-journal, $db-wal and $db-shm, then deploy a fixed migration or the previous release."
  else
    advice="There is no pre-migrate copy older than that start next to $db (looked for $db.pre-migrate-*): restore your own backup of the database."
  fi
  die "migration $name failed halfway (recorded in _prisma_migrations since ${started_stamp}, UTC) and was never rolled back. SQLite keeps the statements that ran before the error, so $db may be partly migrated. The server was not started, no new copy was taken and migrate deploy was not run. $advice See $DOCS."
}

deploy() {
  log "prisma migrate deploy"
  if ! "$PRISMA" migrate deploy; then
    die "prisma migrate deploy failed (output above). The server was not started. ${copy_note:-No copy was taken.} If a migration failed halfway, the next start names the copy to restore. See $DOCS."
  fi
}

baseline_legacy_database() {
  [ -d "prisma/migrations/$BASELINE" ] || die "baseline migration prisma/migrations/$BASELINE is missing from the image. Nothing was changed."
  log "$db has tables but no _prisma_migrations: checking it against $SCHEMA"
  rc=0
  "$PRISMA" migrate diff --from-url "file:$db" --to-schema-datamodel "$SCHEMA" --exit-code || rc=$?
  case "$rc" in
    0) ;;
    2) die "the existing database $db differs from $SCHEMA (differences above), so it was NOT baselined and nothing was changed. The server was not started and no 'prisma db push' is run. Bring the database in line with the schema, or baseline it by hand once you have verified the differences: see $DOCS." ;;
    *) die "could not compare the existing database $db with $SCHEMA (prisma exit $rc, output above). Nothing was changed. See $DOCS." ;;
  esac
  log "schema matches: recording $BASELINE as applied"
  pre_migrate_copy
  if ! "$PRISMA" migrate resolve --applied "$BASELINE"; then
    die "prisma migrate resolve --applied $BASELINE failed (output above). $copy_note. The server was not started. See $DOCS."
  fi
}

if [ ! -e "$db" ]; then
  log "no database file at $db: migrate deploy creates it"
  deploy
else
  [ -f "$db" ] || die "$db exists but is not a regular file. Nothing was changed."
  history=$(count "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'") || exit 1
  if [ "$history" -gt 0 ]; then
    refuse_failed_migration
    st=0
    "$PRISMA" migrate status || st=$?
    if [ "$st" -eq 0 ]; then
      log "migrations up to date: no copy needed"
    else
      log "migrations pending or in an unknown state (prisma migrate status exit $st)"
      pre_migrate_copy
    fi
    deploy
  else
    tables=$(count "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!'") || exit 1
    if [ "$tables" -eq 0 ]; then
      log "database $db has no tables: migrate deploy initialises it"
      deploy
    else
      baseline_legacy_database
      deploy
    fi
  fi
fi

log "database ready, starting: $*"
exec "$@"
