#!/bin/sh
# Routine backup of the production SQLite database, run on the host. It takes
# a consistent copy with `sqlite3 .backup` inside the app container (never a
# `cp` of the live file), verifies the copy with PRAGMA integrity_check, copies
# it out with `docker compose cp` to a directory outside the volume and rotates
# the old backups.
#
#   sh scripts/backup.sh
#
# Environment:
#   COMPOSE_FILE       select the compose file; when set it is passed to every
#                      docker compose call as -f (never hard-coded), when
#                      unset docker compose uses its own default lookup.
#   FORGE_BACKUP_DIR   output directory on the host; unset or empty means
#                      $HOME/project-forge-backups, outside the checkout.
#   FORGE_BACKUP_KEEP  number of backups to keep, default 14 (an empty value
#                      counts as unset); anything else than a positive integer
#                      (zero included) is refused before anything runs.
#
# The database path is never assumed: the running container's DATABASE_URL is
# read with printenv (docs/deployment.md, "Database location"), because that
# is what the app actually has open. A relative file: path resolves against
# /app/prisma, like Prisma does in the container.
#
# The published file is `project-forge-<UTC stamp>.db` (`-<n>` for a second
# run in the same second), mode 600 because the database holds password hashes
# and GitHub tokens, and never carries the `.pre-migrate-` infix that belongs
# to the pre-migrate copies of scripts/start.sh. Publishing is atomic on the
# host: the copy-out goes to a temporary name in the destination directory and
# is moved into place only when it is complete and verified. Rotation keeps
# the newest $FORGE_BACKUP_KEEP files whose name has exactly this shape and
# never touches anything else in the directory.
#
# Any failure exits non-zero without publishing: a partial file never carries
# the final name. The temporary file inside the container is removed on every
# path, including a failure or a signal (trap); only SIGKILL can leave one
# behind (`rm <database file>.tmp-backup-*` in that case).
#
# Tested in tests/integration/backup-script.test.ts with a stub `docker`
# binary on PATH (compose exec runs the given command against a real SQLite
# file, compose cp copies) and the real sqlite3.
set -eu

log() { printf '[db-backup] %s\n' "$*"; }
die() { printf '[db-backup] ERROR: %s\n' "$*" >&2; exit 1; }

# The backups hold password hashes and GitHub tokens.
umask 077

keep=${FORGE_BACKUP_KEEP:-14}
case "$keep" in
  0 | *[!0-9]*) die "FORGE_BACKUP_KEEP must be a positive integer, got '${FORGE_BACKUP_KEEP:-}' (unset or empty means the default 14). Nothing was written." ;;
esac

# COMPOSE_FILE is passed through as an explicit -f when set, otherwise the
# compose CLI applies its own default file lookup.
compose() {
  if [ -n "${COMPOSE_FILE:-}" ]; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose "$@"
  fi
}

container_tmp=""
host_tmp=""
cleanup() {
  [ -z "$host_tmp" ] || rm -f "$host_tmp"
  [ -z "$container_tmp" ] || compose exec -T app rm -f "$container_tmp" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

# The path the running container uses, not the compose-file default.
if ! url=$(compose exec -T app printenv DATABASE_URL); then
  die "cannot read DATABASE_URL from the app container (is it running? docker compose ps). Nothing was written."
fi
url=$(printf '%s' "$url" | tr -d '\r\n')
case "$url" in
  file:*) ;;
  '') die "DATABASE_URL is empty in the app container. Nothing was written." ;;
  *) die "DATABASE_URL in the app container is not a SQLite file: URL: $url. Nothing was written." ;;
esac
db=${url#file:}
db=${db%%\?*}
db=${db#./}
[ -n "$db" ] || die "DATABASE_URL has no file path: $url. Nothing was written."
case "$db" in
  /*) ;;
  *) db="/app/prisma/$db" ;;
esac
case "$db" in
  *"'"*) die "database path must not contain a single quote: $db. Nothing was written." ;;
esac
log "container database: $db"

# The output directory is only created once the container and its database
# resolved: a failure above leaves no directory behind.
if [ -n "${FORGE_BACKUP_DIR:-}" ]; then
  backup_dir=$FORGE_BACKUP_DIR
elif [ -n "${HOME:-}" ]; then
  backup_dir="$HOME/project-forge-backups"
else
  die "FORGE_BACKUP_DIR is unset and HOME is not set: no backup directory to write to. Nothing was written."
fi
mkdir -p "$backup_dir" || die "cannot create the backup directory $backup_dir. Nothing was written."
[ -d "$backup_dir" ] || die "$backup_dir is not a directory. Nothing was written."

# A consistent snapshot inside the container, taken next to the database
# (same as the pre-migrate copy of scripts/start.sh), then checked there
# before a single byte of it is copied out.
container_tmp="$db.tmp-backup.$$"
if ! compose exec -T app sqlite3 "$db" ".backup '$container_tmp'"; then
  die "sqlite3 .backup of $db failed in the app container (missing file, locked, or the volume is full). Nothing was written."
fi
if ! compose exec -T app test -s "$container_tmp"; then
  die "the backup copy $container_tmp is missing or empty in the app container. Nothing was written."
fi
if ! check=$(compose exec -T app sqlite3 "$container_tmp" 'PRAGMA integrity_check;'); then
  die "PRAGMA integrity_check on the backup copy $container_tmp failed (output above). Nothing was written."
fi
check=$(printf '%s' "$check" | tr -d '\r')
[ "$check" = "ok" ] || die "the backup copy failed PRAGMA integrity_check (answer: $(printf '%s' "$check" | tr '\n' ' ')). Nothing was written."

# Copy out to a temporary name; the final name appears only with mv.
host_tmp="$backup_dir/.project-forge-backup.$$.part"
if ! compose cp "app:$container_tmp" "$host_tmp"; then
  die "docker compose cp of $container_tmp out of the app container failed. Nothing was written."
fi
[ -s "$host_tmp" ] || die "the copied-out backup $host_tmp is empty. Nothing was written."
chmod 600 "$host_tmp" || die "cannot set mode 600 on $host_tmp. Nothing was written."

stamp=$(date -u +%Y%m%dT%H%M%SZ)
case "$stamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) die "unexpected answer from date -u: $stamp. Nothing was published." ;;
esac
final="$backup_dir/project-forge-$stamp.db"
n=0
while [ -e "$final" ]; do
  n=$((n + 1))
  final="$backup_dir/project-forge-$stamp-$n.db"
done
mv "$host_tmp" "$final" || die "cannot move the backup into place at $final. Nothing was published."
log "backup written: $final"

# Rotation: delete everything but the newest $keep files of exactly the
# published name shape, `project-forge-YYYYMMDDTHHMMSSZ[-<n>].db` (the sort key
# is the 14 UTC digits plus the numeric suffix, zero-padded). Other names, such
# as a pre-migrate copy or an unrelated file, are never matched or deleted.
# One line per match: "<18 char key> <path>", newest first. It is a function
# because bash 3.2 (the macOS /bin/sh) cannot parse a case pattern starting
# with [ inside $( ).
rotation_candidates() {
  for f in "$backup_dir"/project-forge-*.db; do
    [ -f "$f" ] || continue
    base=${f##*/}
    base=${base%.db}
    base=${base#project-forge-}
    stem=$base
    suffix=${base##*-}
    # n is the numeric suffix, 0 when there is none.
    n=0
    if [ -n "$suffix" ] && [ -z "$(printf '%s' "$suffix" | tr -d 0-9)" ]; then
      stem=${base%"-$suffix"}
      n=$suffix
    fi
    case "$stem" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
      *) continue ;;
    esac
    printf '%s%s %s\n' "$(printf '%s' "$stem" | tr -d 'TZ')" "$(printf '%04d' "$n")" "$f"
  done
}
entries=$(rotation_candidates | LC_ALL=C sort -r)
kept=0
printf '%s\n' "$entries" | cut -c20- | while IFS= read -r old; do
  [ -n "$old" ] || continue
  kept=$((kept + 1))
  if [ "$kept" -le "$keep" ]; then
    continue
  fi
  rm -f "$old" || die "cannot remove the old backup $old"
  log "rotated out old backup: $old"
done
