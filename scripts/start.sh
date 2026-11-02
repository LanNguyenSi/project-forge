#!/bin/sh
# Container start: bring the SQLite database to the committed schema with
# `prisma migrate deploy`, then exec the server command given as arguments.
#
#   sh scripts/start.sh node_modules/.bin/next start
#
# It never runs `prisma db push`. Decision table (the database path comes from
# DATABASE_URL; a relative `file:` path resolves against prisma/, like Prisma):
#
#   file missing, and its directory holds no file of a database
#                                             -> migrate deploy (creates it)
#   file missing, but its directory holds files a database leaves behind
#                                             -> abort, nothing created, unless
#                                                FORGE_ALLOW_NEW_DATABASE=1
#   file missing, and the directory of its path does not exist
#                                             -> abort, nothing created, unless
#                                                FORGE_ALLOW_NEW_DATABASE=1
#   file of 0 bytes, and its directory holds files a database leaves behind
#                                             -> abort, nothing changed, unless
#                                                FORGE_ALLOW_NEW_DATABASE=1
#   file of 0 bytes, nothing of a database next to it
#                                             -> migrate deploy (initialises it)
#   file with bytes but without any table      -> migrate deploy (initialises it)
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
# A missing database file is a first install only when nothing of a database
# lies next to it. Another database file, a -journal, -wal or -shm file or a
# copy of a database in the same directory points to a wrong path (a typo in
# DATABASE_URL), a volume mounted elsewhere or a restore under another name:
# an empty database created there would start a healthy-looking empty
# instance. The start stops instead and lists those files, unless
# FORGE_ALLOW_NEW_DATABASE is exactly 1 (then it warns and creates it).
# A file of 0 bytes at the path counts as missing for that check: the same
# files next to it stop the start, because sqlite3 run on a wrong path leaves
# such a file behind and the next start would fill it with an empty schema. A
# 0-byte file with nothing of a database next to it is treated as a first
# install and is initialised. A file
# with bytes but no table is not looked at by this check. A path whose
# directory does not exist stops the start the same way (a typo in the
# directory part of DATABASE_URL); an existing, empty directory (a fresh
# volume) is a first install.
#
# Every start logs how many pre-migrate copies lie in the database's directory
# and their total size, and warns when there are more than
# FORGE_PRE_MIGRATE_COPIES_WARN (default 5). Nothing here deletes a copy.
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
# Infix of the pre-migrate copy names. Only names that copy_key accepts count
# as restore points or loop copies; the copy report and the new-database check
# match any name with the infix.
COPY_INFIX=".pre-migrate-"
# Default of FORGE_PRE_MIGRATE_COPIES_WARN: a start warns above this many
# pre-migrate copies in the database's directory. It is above COPY_LOOP_LIMIT,
# so the copies of one stopped restart loop plus a restore point or two do not
# warn on their own; more than that means copies pile up without anyone
# removing them.
COPIES_WARN_DEFAULT=5
# _prisma_migrations.started_at as 14 digits (YYYYMMDDHHMMSS, UTC). prisma 5.22
# writes milliseconds since the epoch; a text date (the column default) works too.
# NULL when the value cannot be read.
STARTED_DIGITS="CASE WHEN typeof(started_at) IN ('integer', 'real') THEN strftime('%Y%m%d%H%M%S', started_at / 1000, 'unixepoch') ELSE strftime('%Y%m%d%H%M%S', started_at) END"
# The same for finished_at.
FINISHED_DIGITS="CASE WHEN typeof(finished_at) IN ('integer', 'real') THEN strftime('%Y%m%d%H%M%S', finished_at / 1000, 'unixepoch') ELSE strftime('%Y%m%d%H%M%S', finished_at) END"

log() { printf '[db-start] %s\n' "$*"; }
warn() { printf '[db-start] WARNING: %s\n' "$*" >&2; }
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
# The database's directory with a trailing slash ("/" for a file in the root).
# The new-database check and the copy report look only here.
db_dir="${db%/*}/"

# The start reads the database state and takes the copy with sqlite3. Checked
# once, before anything else, so that no later step depends on it by accident.
command -v "$SQLITE3" >/dev/null 2>&1 || die "sqlite3 not found (looked for $SQLITE3): it is needed to read the state of $db and to take the pre-migrate copy. Nothing was changed."

# Unset or empty: the default. Anything but 0 to 999999999 gets a warning and
# the default: the knob only controls a log warning, so it never stops a start.
copies_warn=${FORGE_PRE_MIGRATE_COPIES_WARN:-$COPIES_WARN_DEFAULT}
case "$copies_warn" in
  *[!0-9]*|??????????*)
    warn "FORGE_PRE_MIGRATE_COPIES_WARN must be a whole number from 0 to 999999999, got '$copies_warn'; using the default $COPIES_WARN_DEFAULT."
    copies_warn=$COPIES_WARN_DEFAULT
    ;;
esac

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
    advice="There is no pre-migrate copy older than that start next to $db (looked for $db${COPY_INFIX}YYYYMMDDTHHMMSSZ). If the start that ran the failed migration created $db (no database file or no table before it, so it took no copy), stop the container, delete $db, $db-journal, $db-wal and $db-shm and fix the migration. Otherwise restore your own backup of the database. After such a delete the next start creates the database again, unless other database files lie next to it: then start once with FORGE_ALLOW_NEW_DATABASE=1."
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
  deploy_note="$db $1 before this start, so no copy was taken. If a migration failed halfway, stop the container, delete $db, $db-journal, $db-wal and $db-shm and fix the migration. The next start then creates the database again, unless other database files lie next to it: then start once with FORGE_ALLOW_NEW_DATABASE=1."
}

# Prints a byte count for people: "512 B", "1.5 KiB", up to TiB, with one
# decimal (cut off, not rounded).
human_size() {
  hs_div=1
  for hs_next in KiB MiB GiB TiB; do
    [ "$1" -ge $((hs_div * 1024)) ] || break
    hs_div=$((hs_div * 1024))
    hs_unit=$hs_next
  done
  if [ "$hs_div" -eq 1 ]; then
    printf '%s B\n' "$1"
  else
    hs_tenths=$(($1 * 10 / hs_div))
    printf '%s.%s %s\n' "$((hs_tenths / 10))" "$((hs_tenths % 10))" "$hs_unit"
  fi
}

# Logs, on every start, how many pre-migrate copies lie in the database's
# directory and their total size, and warns when there are more than
# $copies_warn. It counts every regular file matching <dir>/*.pre-migrate-*,
# stamped or not and of any database, which is what the `ls` command in
# docs/deployment.md lists. It only looks: nothing is deleted or moved, and a
# copy whose size cannot be read is counted and reported, never fatal.
report_copies() {
  rc_n=0
  rc_bytes=0
  rc_unread=0
  for f in "$db_dir"*"$COPY_INFIX"*; do
    [ -f "$f" ] || continue
    rc_n=$((rc_n + 1))
    rc_size=$({ wc -c <"$f"; } 2>/dev/null | tr -d ' ')
    case "$rc_size" in
      ''|*[!0-9]*) rc_unread=$((rc_unread + 1)) ;;
      *) rc_bytes=$((rc_bytes + rc_size)) ;;
    esac
  done
  rc_total="$(human_size "$rc_bytes") in total"
  [ "$rc_unread" -eq 0 ] || rc_total="$rc_total, the size of $rc_unread could not be read"
  log "pre-migrate copies in $db_dir: $rc_n, $rc_total"
  [ "$rc_n" -le "$copies_warn" ] || warn "$rc_n pre-migrate copies in $db_dir ($rc_total), more than $copies_warn (FORGE_PRE_MIGRATE_COPIES_WARN). Each is a full copy of a database on the same volume and nothing deletes them: remove the ones you no longer need. See $DOCS."
}

# Sets $siblings to the names (comma separated) of the regular files in the
# database's directory that a database leaves behind: another database file
# (*.db, *.sqlite, *.sqlite3), a SQLite -journal, -wal or -shm file, or a copy
# of a database: a pre-migrate copy of any database (*.pre-migrate-*), any other
# <name>.db.<suffix> (such as the .manual-<stamp> copy and the .restore file
# that docs/deployment.md uses), and the temporary copies of this script
# (*.tmp-pre-migrate.*) and of scripts/backup.sh (*.tmp-backup.*), which both
# are only ever written from an existing database. Dot files count too,
# directories do not. The database file itself is never listed.
find_db_siblings() {
  siblings=""
  for e in "$db_dir"* "$db_dir".[!.]* "$db_dir"..?*; do
    [ -f "$e" ] || continue
    # The database file itself (a 0-byte one is checked for siblings) is no sibling.
    [ "${e##*/}" != "${db##*/}" ] || continue
    case ${e##*/} in
      *.db|*.sqlite|*.sqlite3|*-journal|*-wal|*-shm|*.db.*|*"$COPY_INFIX"*|*.tmp-pre-migrate.*|*.tmp-backup.*)
        siblings="$siblings${siblings:+, }${e##*/}"
        ;;
    esac
  done
}

# Sets $allow to FORGE_ALLOW_NEW_DATABASE and $allow_note to the words the
# refusals use for its value. Only the exact value 1 allows a new database (any
# other value, empty included, does not).
read_allow_new_database() {
  allow=${FORGE_ALLOW_NEW_DATABASE:-}
  case "$allow" in
    '') allow_note="it is unset or empty now" ;;
    *) allow_note="it is '$allow' now, and only the value 1 counts" ;;
  esac
}

# A missing database file, or one of 0 bytes, next to files of a database is no
# first install: the path may have a typo, the volume may be mounted elsewhere
# or a restore went to another name, and an empty database created here would
# start an empty instance that looks healthy. The start stops before any
# migration, unless FORGE_ALLOW_NEW_DATABASE is exactly 1. The argument is
# "missing" (no file at the path) or "empty" (a file of 0 bytes).
refuse_new_database_next_to_old_files() {
  find_db_siblings
  [ -n "$siblings" ] || return 0
  read_allow_new_database
  if [ "${1:-missing}" = empty ]; then
    what="the database file at $db is empty (0 bytes)"
    creates="migrate deploy initialises that empty file as a new database"
    hint="An empty file here is often left by a sqlite3 call on a path that did not exist."
  else
    what="no database file at $db"
    creates="migrate deploy creates a new, empty database at $db"
    hint=""
  fi
  if [ "$allow" = 1 ]; then
    warn "$what, but $db_dir holds files that a database leaves behind: $siblings. FORGE_ALLOW_NEW_DATABASE=1 is set, so $creates. Remove FORGE_ALLOW_NEW_DATABASE once it exists."
    return 0
  fi
  die "$what, but $db_dir holds files that a database leaves behind: $siblings. No database was created and nothing was changed.${hint:+ $hint} Check DATABASE_URL (FORGE_DATABASE_URL in .env for the compose stack): a typo, a volume mounted at another place or a restore under another name looks like this. Fix the path or put the database file back, then start again. To create a new, empty database at $db on purpose, start once with FORGE_ALLOW_NEW_DATABASE=1 ($allow_note); creating it discards a $db-journal or $db-wal left under that name, so move them away first if the old database may need them. See $DOCS."
}

# A database path whose directory does not exist is no first install either: a
# fresh volume is an existing, empty directory (its mount point), so a missing
# directory is far more likely a typo in the directory part of DATABASE_URL than
# a deliberate new location, and prisma would create the directories and an
# empty database in the wrong place. Stops before any migration, unless
# FORGE_ALLOW_NEW_DATABASE is exactly 1 (then it warns; prisma creates the
# directories).
refuse_missing_database_directory() {
  [ ! -d "$db_dir" ] || return 0
  read_allow_new_database
  if [ "$allow" = 1 ]; then
    warn "the directory $db_dir of the database path $db does not exist. FORGE_ALLOW_NEW_DATABASE=1 is set, so migrate deploy creates the directory and a new, empty database at $db. Remove FORGE_ALLOW_NEW_DATABASE once it exists."
    return 0
  fi
  die "the directory $db_dir of the database path $db does not exist (or is not a directory). No database was created and nothing was changed. This is most likely a typo in DATABASE_URL (FORGE_DATABASE_URL in .env for the compose stack); a new volume is an existing, empty directory and does not look like this. Fix the path, then start again. To create the directory and a new, empty database at $db on purpose, start once with FORGE_ALLOW_NEW_DATABASE=1 ($allow_note). See $DOCS."
}

report_copies

if [ ! -e "$db" ]; then
  refuse_missing_database_directory
  refuse_new_database_next_to_old_files missing
  log "no database file at $db: migrate deploy creates it"
  new_database_note "did not exist"
  deploy
else
  [ -f "$db" ] || die "$db exists but is not a regular file. Nothing was changed."
  # A file of 0 bytes counts as missing for the check on files next to it. -s
  # follows a symlink, like -e above.
  [ -s "$db" ] || refuse_new_database_next_to_old_files empty
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
