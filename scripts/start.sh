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
#   _prisma_migrations present, nothing pending
#                                             -> migrate deploy (no-op), no copy
#   _prisma_migrations present, a migration pending
#                                             -> copy, then migrate deploy;
#                                                abort without a copy once 3 copies are newer
#                                                than the newest applied migration
#   _prisma_migrations present, prisma/migrations holds a dot-directory, a
#   symlink or a directory without migration.sql
#                                             -> abort, nothing changed, no copy
#   tables but no _prisma_migrations (a database that `db push` created):
#       schema equals prisma/schema.prisma    -> copy, mark the baseline migration
#                                                as applied, migrate deploy
#       schema differs, or the check fails    -> abort, nothing changed
#
# "Pending" is computed here with sqlite3, not asked from `prisma migrate
# status` (prisma 5.22 reports a migration marked rolled back as up to date and
# then `migrate deploy` applies it): every migration in prisma/migrations
# (a directory with a migration.sql) that has no applied row in
# _prisma_migrations, applied meaning finished_at set and rolled_back_at empty.
# Rows of migrations the image does not ship are not looked at.
#
# Every start that is about to change an existing database (a pending
# migration, or the baseline record on a `db push` database) first writes a new
# copy `<db>.pre-migrate-<UTC timestamp>[-<n>]` next to the database file, made
# with `sqlite3 .backup` (consistent even with a journal left by a crash). Any
# failure of the copy, the check, the resolve or the deploy aborts with a
# non-zero status and the server command is not started.
#
# A migration that fails halfway stays in _prisma_migrations as failed (no
# finished_at, no rolled_back_at), and SQLite does not undo the statements that
# ran before the error. The next start finds that row first and stops without
# touching the file, so a restart loop takes no copy of the damaged file. The
# message names the newest pre-migrate copy whose stamp is not newer than the
# failed migration's start, which is the one to restore, and warns when other
# history rows started after that copy.
#
# A deploy can also fail before prisma records a row (the database is locked
# for writing, prisma rejects an entry in prisma/migrations, prisma dies early).
# That leaves no failed row, so each restart would write another full copy.
# Before a copy, the script counts the stamped copies newer than the newest
# applied migration (the newest finished_at of a row that is not rolled back; no
# such row: every stamped copy counts) and aborts without a copy or a deploy
# once there are COPY_LOOP_LIMIT of them. The operator fixes the cause and
# removes the surplus copies; an applied migration resets the count.
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
MIGRATIONS="prisma/migrations"
DOCS='docs/deployment.md, section "Database migrations"'
# Stamped copies newer than the newest applied migration at which a start stops.
COPY_LOOP_LIMIT=3
# Infix of the pre-migrate copy names. Only names that copy_key accepts count.
COPY_INFIX=".pre-migrate-"
# _prisma_migrations.started_at as 14 digits (YYYYMMDDHHMMSS, UTC). prisma 5.22
# writes milliseconds since the epoch; a text date (the column default) works too.
# NULL when the value cannot be read.
STARTED_DIGITS="CASE WHEN typeof(started_at) IN ('integer', 'real') THEN strftime('%Y%m%d%H%M%S', started_at / 1000, 'unixepoch') ELSE strftime('%Y%m%d%H%M%S', started_at) END"
# The same for finished_at.
FINISHED_DIGITS="CASE WHEN typeof(finished_at) IN ('integer', 'real') THEN strftime('%Y%m%d%H%M%S', finished_at / 1000, 'unixepoch') ELSE strftime('%Y%m%d%H%M%S', finished_at) END"

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

# Said when `migrate deploy` fails. Each branch below sets it.
deploy_note="No copy was taken."
copy_path=""

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

# The one parser of pre-migrate copy names, used by the copy step for the name
# it writes and by the restore-point search for the names it finds. A name
# counts only in exactly the form `<db>.pre-migrate-YYYYMMDDTHHMMSSZ`, with an
# optional `-<n>` (a second copy in the same second); for that it prints
# "<14 digits> <n>" (n is 0 without a suffix). Anything else under the prefix,
# such as an operator's own `<db>.pre-migrate-manual`, fails and is ignored.
copy_key() {
  ck_rest=${1#"$db$COPY_INFIX"}
  [ "$ck_rest" != "$1" ] || return 1
  ck_stamp=${ck_rest%%-*}
  case "$ck_stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  ck_n=0
  if [ "$ck_rest" != "$ck_stamp" ]; then
    ck_n=${ck_rest#"$ck_stamp"-}
    case "$ck_n" in
      ''|*[!0-9]*|??????????*) return 1 ;;
    esac
  fi
  printf '%s %s\n' "$(printf '%s' "$ck_stamp" | tr -d TZ)" "$ck_n"
}

pre_migrate_copy() {
  now=$(date -u +%Y%m%dT%H%M%SZ) || die "cannot read the clock for the copy name"
  target="$db$COPY_INFIX$now"
  n=0
  while [ -e "$target" ]; do
    n=$((n + 1))
    target="$db$COPY_INFIX$now-$n"
  done
  # A name the restore-point search would not recognise is no restore point.
  copy_key "$target" >/dev/null || die "the pre-migrate copy name $target is not of the form $db${COPY_INFIX}YYYYMMDDTHHMMSSZ[-<n>] (clock output: $now). Nothing was changed."
  tmp="$db.tmp-pre-migrate.$$"
  # umask 077: the database holds password hashes and GitHub tokens.
  if ! (umask 077 && "$SQLITE3" "$db" ".backup '$tmp'"); then
    rm -f "$tmp"
    die "could not copy $db before migrating (disk full or read-only volume?). Nothing was changed."
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "pre-migrate copy of $db is empty. Nothing was changed."; }
  mv "$tmp" "$target" || { rm -f "$tmp"; die "could not move the pre-migrate copy into place at $target. Nothing was changed."; }
  log "pre-migrate copy written: $target"
  copy_path=$target
  deploy_note="pre-migrate copy: $target. If a migration failed halfway, the next start names the copy to restore."
}

# Prints, one per line, every migration the image ships (a directory under
# prisma/migrations with a migration.sql) that _prisma_migrations does not
# record as applied (finished_at set, rolled_back_at empty). That is what
# `migrate deploy` applies: a migration marked rolled back, one that finished
# and was marked rolled back later, and one older than the newest applied
# migration all count. Rows of migrations the image does not ship (written by a
# newer release before a rollback of the code) are not looked at: deploy
# ignores them, and an older release must not copy the file on every start.
pending_migrations() {
  for sql in "$MIGRATIONS"/*/migration.sql; do
    [ -f "$sql" ] || continue
    name=${sql#"$MIGRATIONS"/}
    name=${name%/migration.sql}
    esc=$(printf '%s' "$name" | sed "s/'/''/g")
    applied=$(count "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '$esc' AND finished_at IS NOT NULL AND rolled_back_at IS NULL") || exit 1
    [ "$applied" -gt 0 ] || printf '%s\n' "$name"
  done
}

# Stops the start when prisma/migrations holds an entry that this script and
# prisma 5.22 read differently, before any pending set is computed: prisma lists
# every directory entry including dot-directories, leaves out symlinks and fails
# with P3015 on a directory without migration.sql, while the pending set below
# follows the shell glob (no dot entries, symlinks followed). Regular files such
# as migration_lock.toml are fine.
check_migrations_dir() {
  for e in "$MIGRATIONS"/* "$MIGRATIONS"/.[!.]* "$MIGRATIONS"/..?*; do
    if [ -L "$e" ]; then
      die "$e is a symlink: prisma leaves it out and this start would count it as a migration. Remove it. Nothing was changed. See $DOCS."
    fi
    [ -d "$e" ] || continue
    case ${e##*/} in
      .*) die "$e is a directory whose name starts with a dot: prisma treats it as a migration, this start would not. Remove it. Nothing was changed. See $DOCS." ;;
    esac
    [ -f "$e/migration.sql" ] || die "$e has no migration.sql (prisma fails on it with P3015). Remove it or add the file. Nothing was changed. See $DOCS."
  done
}

# Stops the start, before a new copy, when COPY_LOOP_LIMIT stamped copies are
# newer (by stamp second) than the newest applied migration. A deploy that fails
# before prisma writes a row leaves no failed migration for
# refuse_failed_migration to find, so without this every restart adds a full copy.
refuse_copy_loop() {
  if [ "${1:-}" = no-history ]; then
    # No _prisma_migrations yet (the baseline branch): every stamped copy counts.
    last=0
    since="copies, no migration applied yet"
  else
    since="copies since the last applied migration"
    last=$(query "SELECT COALESCE(max(CAST($FINISHED_DIGITS AS INTEGER)), 0) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL") || exit 1
  fi
  case "$last" in
    ''|*[!0-9]*) die "cannot read the finish time of the newest applied migration in $db. Nothing was changed. See $DOCS." ;;
  esac
  newer=0
  for f in "$db$COPY_INFIX"*; do
    [ -f "$f" ] || continue
    key=$(copy_key "$f") || continue
    [ "${key% *}" -gt "$last" ] || continue
    newer=$((newer + 1))
  done
  [ "$newer" -lt "$COPY_LOOP_LIMIT" ] || die "deploy keeps failing before it records a migration ($newer $since); nothing was changed. No new copy was taken and migrate deploy was not run. Find the cause in the output of the earlier starts (for example a locked database or a migration prisma rejects), fix it, then remove all but one of the copies stamped after the newest applied migration (older copies do not count) and start again. A database restored from an older copy leaves the later copies counting: move them to a name outside the $COPY_INFIX prefix. See $DOCS."
}

# Stops the start when _prisma_migrations holds a migration that began and
# neither finished nor was marked rolled back. Prisma does not undo the
# statements of a failed SQLite migration, so the file may be half migrated.
# Nothing is copied here (a copy of the damaged file is not a restore point)
# and `migrate deploy` is not run (it refuses on that row anyway).
refuse_failed_migration() {
  row=$(query "SELECT rowid || '|' || COALESCE($STARTED_DIGITS, '') || '|' || COALESCE(started_at, '') || '|' || COALESCE(migration_name, '') FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name LIMIT 1") || exit 1
  [ -n "$row" ] || return 0
  rid=${row%%|*}
  rest=${row#*|}
  started=${rest%%|*}
  rest=${rest#*|}
  started_raw=${rest%%|*}
  name=${rest#*|}
  case "$started" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "cannot read the start time ($started_raw) of the failed migration $name in $db. Nothing was changed. See $DOCS." ;;
  esac
  started_text="${started%??????}T${started#????????}Z"
  best=""
  best_stamp=0
  best_n=0
  for f in "$db$COPY_INFIX"*; do
    [ -f "$f" ] || continue
    key=$(copy_key "$f") || continue
    k_stamp=${key% *}
    k_n=${key#* }
    [ "$k_stamp" -le "$started" ] || continue
    if [ -z "$best" ] || [ "$k_stamp" -gt "$best_stamp" ] || { [ "$k_stamp" -eq "$best_stamp" ] && [ "$k_n" -gt "$best_n" ]; }; then
      best=$f
      best_stamp=$k_stamp
      best_n=$k_n
    fi
  done
  if [ -n "$best" ]; then
    advice="Stop the container, restore $best (the newest pre-migrate copy taken before that migration started) and remove $db-journal, $db-wal and $db-shm, then deploy a fixed migration or the previous release."
    # Rows started in the copy's second or later, other than the failed one.
    # A start time that cannot be read counts as later.
    later=$(query "SELECT group_concat(migration_name, ', ') FROM (SELECT migration_name FROM _prisma_migrations WHERE rowid <> $rid AND COALESCE(CAST($STARTED_DIGITS AS INTEGER), $best_stamp) >= $best_stamp ORDER BY started_at, migration_name)") || exit 1
    if [ -n "$later" ]; then
      advice="$advice Warning: _prisma_migrations also has rows that started after that copy was taken ($later), so the copy may predate later changes. A migration that the same start applied before the failure is applied again after the restore; anything done after the copy outside this start script (a migration applied or resolved by hand) is undone by the restore. Check those rows before you restore."
    fi
  else
    advice="There is no pre-migrate copy older than that start next to $db (looked for $db${COPY_INFIX}YYYYMMDDTHHMMSSZ). If the start that ran the failed migration created $db (no database file or no table before it, so it took no copy), stop the container, delete $db, $db-journal, $db-wal and $db-shm and fix the migration. Otherwise restore your own backup of the database."
  fi
  die "migration $name failed halfway (recorded in _prisma_migrations since ${started_text}, UTC) and was never rolled back. SQLite keeps the statements that ran before the error, so $db may be partly migrated. The server was not started, no new copy was taken and migrate deploy was not run. $advice See $DOCS."
}

deploy() {
  log "prisma migrate deploy"
  if ! "$PRISMA" migrate deploy; then
    die "prisma migrate deploy failed (output above). The server was not started. $deploy_note See $DOCS."
  fi
}

baseline_legacy_database() {
  [ -d "$MIGRATIONS/$BASELINE" ] || die "baseline migration $MIGRATIONS/$BASELINE is missing from the image. Nothing was changed."
  log "$db has tables but no _prisma_migrations: checking it against $SCHEMA"
  rc=0
  "$PRISMA" migrate diff --from-url "file:$db" --to-schema-datamodel "$SCHEMA" --exit-code || rc=$?
  case "$rc" in
    0) ;;
    2) die "the existing database $db differs from $SCHEMA (differences above), so it was NOT baselined and nothing was changed. The server was not started and no 'prisma db push' is run. Bring the database in line with the schema, or baseline it by hand once you have verified the differences: see $DOCS." ;;
    *) die "could not compare the existing database $db with $SCHEMA (prisma exit $rc, output above). Nothing was changed. See $DOCS." ;;
  esac
  log "schema matches: recording $BASELINE as applied"
  refuse_copy_loop no-history
  pre_migrate_copy
  if ! "$PRISMA" migrate resolve --applied "$BASELINE"; then
    die "prisma migrate resolve --applied $BASELINE failed (output above). pre-migrate copy: $copy_path. The server was not started. See $DOCS."
  fi
}

# Said when the database had nothing to keep before this start.
new_database_note() {
  deploy_note="$db $1 before this start, so no copy was taken. If a migration failed halfway, stop the container, delete $db, $db-journal, $db-wal and $db-shm and fix the migration."
}

if [ ! -e "$db" ]; then
  log "no database file at $db: migrate deploy creates it"
  new_database_note "did not exist"
  deploy
else
  [ -f "$db" ] || die "$db exists but is not a regular file. Nothing was changed."
  history=$(count "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'") || exit 1
  if [ "$history" -gt 0 ]; then
    refuse_failed_migration
    check_migrations_dir
    pending=$(pending_migrations) || exit 1
    if [ -z "$pending" ]; then
      log "every migration in $MIGRATIONS is applied: no copy needed"
      deploy_note="No copy was taken: no migration was pending."
    else
      refuse_copy_loop
      log "migrations to apply: $(printf '%s' "$pending" | tr '\n' ' ')"
      pre_migrate_copy
    fi
    deploy
  else
    tables=$(count "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!'") || exit 1
    if [ "$tables" -eq 0 ]; then
      log "database $db has no tables: migrate deploy initialises it"
      new_database_note "had no tables"
      deploy
    else
      baseline_legacy_database
      deploy
    fi
  fi
fi

log "database ready, starting: $*"
exec "$@"
