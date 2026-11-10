#!/bin/sh
# Routine backup of the production SQLite database, run on the host. It takes
# a consistent copy with `sqlite3 .backup` inside the app container (never a
# `cp` of the live file), verifies the copy with PRAGMA integrity_check, copies
# it out with `docker compose cp` to a directory outside the volume and rotates
# the old backups.
#
#   sh scripts/backup.sh
#   sh scripts/backup.sh --check-fresh [hours]
#
# Environment:
#   COMPOSE_FILE       select the compose file; it is never re-packed into a
#                      -f argument here but left in the environment, where the
#                      compose CLI reads it itself (its own list format with
#                      COMPOSE_PATH_SEPARATOR included).
#   FORGE_BACKUP_DIR   output directory on the host; unset or empty means
#                      $HOME/project-forge-backups, outside the checkout.
#   FORGE_BACKUP_KEEP  number of backups to keep, default 14 (an empty value
#                      counts as unset); anything else than a positive integer
#                      (zero included) is refused before anything runs.
#
# After a verified backup is published, `$FORGE_BACKUP_DIR/.last-success` is
# replaced (temporary file, then mv) with one line: the UTC time and the file
# name of that backup. It is never written on a failure, so its modification
# time is "the last time a backup really succeeded".
# `--check-fresh [hours]` takes no backup and needs no container: it exits 0 when the
# stamp exists and is younger than that many hours (default 26, a nightly
# run plus slack; a positive integer), and 1 when the stamp is missing,
# empty or older, or the directory cannot be resolved. For monitoring.
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
# behind (`rm <database file>.tmp-backup.*` in that case).
#
# Tested in tests/integration/backup-script.test.ts with a stub `docker`
# binary on PATH (compose exec runs the given command against a real SQLite
# file, compose cp copies) and the real sqlite3.
set -eu

log() { printf '[db-backup] %s\n' "$*"; }
die() { printf '[db-backup] ERROR: %s\n' "$*" >&2; exit 1; }

# The backups hold password hashes and GitHub tokens.
umask 077

# The directory the backups (and the stamp) live in: an explicit
# FORGE_BACKUP_DIR wins, empty counts as unset. Resolves only, creates nothing.
resolve_backup_dir() {
  if [ -n "${FORGE_BACKUP_DIR:-}" ]; then
    backup_dir=$FORGE_BACKUP_DIR
  elif [ -n "${HOME:-}" ]; then
    backup_dir="$HOME/project-forge-backups"
  else
    return 1
  fi
}

case "${1:-}" in
  '') ;;
  --check-fresh)
    [ "$#" -le 2 ] || die "usage: sh scripts/backup.sh --check-fresh [hours]"
    hours=26
    if [ "$#" -eq 2 ]; then hours=$2; fi
    case "$hours" in
      '' | 0* | *[!0-9]* | ???????*) die "--check-fresh hours must be a positive integer without a leading zero and at most 6 digits, got '$hours'." ;;
    esac
    resolve_backup_dir || die "FORGE_BACKUP_DIR is unset and HOME is not set: no backup directory to check."
    [ -s "$backup_dir/.last-success" ] || die "no backup stamp at $backup_dir/.last-success: no backup has succeeded there yet."
    if [ -z "$(find "$backup_dir/.last-success" -mmin "-$((hours * 60))" 2>/dev/null)" ]; then
      die "the last successful backup is older than $hours hours: $(cat "$backup_dir/.last-success")"
    fi
    log "ok: last successful backup is younger than $hours hours: $(cat "$backup_dir/.last-success")"
    exit 0
    ;;
  *) die "unknown argument '$1' (usage: sh scripts/backup.sh [--check-fresh [hours]])" ;;
esac

keep=${FORGE_BACKUP_KEEP:-14}
case "$keep" in
  0 | *[!0-9]*) die "FORGE_BACKUP_KEEP must be a positive integer, got '${FORGE_BACKUP_KEEP:-}' (unset or empty means the default 14). Nothing was written." ;;
esac

# COMPOSE_FILE is left in the environment untouched: the compose CLI reads it
# there itself, including its list format (split on COMPOSE_PATH_SEPARATOR);
# a single -f "$COMPOSE_FILE" would break that list.
compose() {
  docker compose "$@"
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
resolve_backup_dir || die "FORGE_BACKUP_DIR is unset and HOME is not set: no backup directory to write to. Nothing was written."
mkdir -p "$backup_dir" || die "cannot create the backup directory $backup_dir. Nothing was written."
[ -d "$backup_dir" ] || die "$backup_dir is not a directory. Nothing was written."

# A consistent snapshot inside the container, taken next to the database
# (same as the pre-migrate copy of scripts/start.sh), then checked there
# before a single byte of it is copied out.
# A missing or empty database never reaches .backup: sqlite3 would create an
# empty file at that path, back it up successfully and publish a valid but
# empty backup that then counts toward the rotation.
if ! compose exec -T app test -s "$db"; then
  die "no non-empty database file at $db in the app container (check DATABASE_URL and the app volume). Nothing was written."
fi
container_tmp="$db.tmp-backup.$$"
# The snapshot holds the same password hashes and GitHub tokens as the database.
# docker compose exec starts a fresh process with the container's own default
# umask (typically 022), so the copy would be world-readable on the volume
# until the trap removes it, and a SIGKILL would leave it behind. Set the umask
# inside the container (as scripts/start.sh does for its pre-migrate copy); the
# two paths are passed as positional arguments, never interpolated into the
# sh -c string.
# shellcheck disable=SC2016  # $1 and $2 expand in the container's sh, not here.
if ! compose exec -T app sh -c 'umask 077 && sqlite3 "$1" ".backup '"'"'$2'"'"'"' sh "$db" "$container_tmp"; then
  die "sqlite3 .backup of $db failed in the app container (the database is locked, or the volume is full). Nothing was written."
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

# Freshness stamp, only now that the verified backup is published. A failure to
# write it fails the run: a backup nobody can see is worth a non-zero exit.
stamp_tmp="$backup_dir/.last-success.$$.tmp"
host_tmp=$stamp_tmp
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${final##*/}" > "$stamp_tmp" \
  || die "cannot write the backup stamp $stamp_tmp (the backup itself is published: $final)."
mv "$stamp_tmp" "$backup_dir/.last-success" \
  || die "cannot move the backup stamp into place (the backup itself is published: $final)."
host_tmp=""

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
