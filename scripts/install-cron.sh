#!/bin/sh
# Installs the two host cron entries of project-forge into the invoking user's
# crontab: the hourly forge_tmp prune and the nightly scripts/backup.sh. Run it
# on the deploy host, from anywhere; the paths are derived from the checkout this
# script lives in.
#
#   FORGE_BACKUP_DIR=/var/backups/project-forge sh scripts/install-cron.sh
#   sh scripts/install-cron.sh --dry-run     # print the block, change nothing
#   sh scripts/install-cron.sh --remove      # delete the block, nothing else
#
# Both entries live in one marked block (BEGIN/END comment lines). A re-run
# replaces that block in place; every other line of the crontab is passed
# through untouched. A re-run that changes nothing does not call `crontab`.
# A block with a missing, doubled or reversed marker is refused (nothing is
# guessed about what to delete).
#
# Environment:
#   FORGE_BACKUP_DIR   REQUIRED, an absolute path. Cron runs with the crontab
#                      owner's HOME and a minimal environment, so the default
#                      of backup.sh ($HOME/project-forge-backups) is not
#                      trusted here: unset or empty is refused (--remove does
#                      not need it).
#   FORGE_BACKUP_TIME  HH:MM (24 h) of the nightly backup, default 03:15 (an
#                      empty value counts as unset); anything else is refused.
#   FORGE_BACKUP_LOG   log file of both entries, an absolute path, default
#                      $FORGE_BACKUP_DIR/cron.log (an empty value counts as
#                      unset).
#   FORGE_CRONTAB      the crontab program, default `crontab` from PATH.
#
# Paths go into the crontab inside single quotes; a path with a single quote,
# a newline or a percent sign (cron turns % into a newline) is refused.
#
# Tested in tests/integration/install-cron.test.ts with a stub `crontab`.
set -eu

die() { printf '[install-cron] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[install-cron] %s\n' "$*"; }

mode=install
for arg in "$@"; do
  case "$arg" in
    --dry-run) [ "$mode" = install ] || die "--dry-run and --remove exclude each other."; mode=dry-run ;;
    --remove) [ "$mode" = install ] || die "--dry-run and --remove exclude each other."; mode=remove ;;
    *) die "unknown argument '$arg' (usage: sh scripts/install-cron.sh [--dry-run | --remove])" ;;
  esac
done

crontab_bin=${FORGE_CRONTAB:-crontab}
BEGIN='# BEGIN project-forge (managed by scripts/install-cron.sh, do not edit)'
END='# END project-forge'

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/forge-install-cron.XXXXXX") || die "cannot create a temporary directory."
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM

# A value that goes into a crontab line: absolute, one line, quotable, no %.
check_path() {
  case "$2" in
    /*) ;;
    *) die "$1 must be an absolute path, got '$2'." ;;
  esac
  case "$2" in
    *"'"* | *%*) die "$1 must not contain a single quote or a percent sign: $2" ;;
  esac
  case "$2" in
    *"
"*) die "$1 must not contain a newline." ;;
  esac
}

# Writes the new block into $work/block.
build_block() {
  [ -n "${FORGE_BACKUP_DIR:-}" ] || die "FORGE_BACKUP_DIR is unset or empty. Cron runs with the crontab owner's HOME, so the backup directory must be named explicitly, for example FORGE_BACKUP_DIR=/var/backups/project-forge. Nothing was changed."
  check_path FORGE_BACKUP_DIR "$FORGE_BACKUP_DIR"

  time=${FORGE_BACKUP_TIME:-03:15}
  case "$time" in
    [0-9][0-9]:[0-9][0-9]) ;;
    *) die "FORGE_BACKUP_TIME must be HH:MM, got '$time'. Nothing was changed." ;;
  esac
  hour=${time%:*}
  minute=${time#*:}
  # Without the leading zero, so 08 is never read as octal.
  hour=${hour#0}
  minute=${minute#0}
  [ "$hour" -le 23 ] && [ "$minute" -le 59 ] \
    || die "FORGE_BACKUP_TIME must be a valid 24 h time, got '$time'. Nothing was changed."

  logfile=${FORGE_BACKUP_LOG:-$FORGE_BACKUP_DIR/cron.log}
  check_path FORGE_BACKUP_LOG "$logfile"

  root=$(cd "$(dirname "$0")/.." && pwd -P) || die "cannot resolve the checkout directory."
  check_path "the checkout path" "$root"

  {
    printf '%s\n' "$BEGIN"
    printf '0 * * * * cd '"'%s'"' && docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} + >> '"'%s'"' 2>&1\n' "$root" "$logfile"
    printf '%d %d * * * cd '"'%s'"' && FORGE_BACKUP_DIR='"'%s'"' sh ./scripts/backup.sh >> '"'%s'"' 2>&1\n' "$minute" "$hour" "$root" "$FORGE_BACKUP_DIR" "$logfile"
    printf '%s\n' "$END"
  } > "$work/block"
}

if [ "$mode" != remove ]; then
  build_block
fi
if [ "$mode" = dry-run ]; then
  cat "$work/block"
  exit 0
fi

# The current crontab. "no crontab for <user>" means empty; any other failure
# of `crontab -l` is not guessed around, because writing back would then
# replace a crontab that could not be read.
if "$crontab_bin" -l > "$work/current" 2> "$work/current.err"; then
  :
else
  case "$(cat "$work/current.err")" in
    *"no crontab"*) : > "$work/current" ;;
    *) die "cannot read the current crontab: $(cat "$work/current.err"). Nothing was changed." ;;
  esac
fi

begins=$(grep -c -x -F "$BEGIN" "$work/current" || true)
ends=$(grep -c -x -F "$END" "$work/current" || true)
if [ "$begins" != "$ends" ] || [ "$begins" -gt 1 ]; then
  die "the crontab has $begins BEGIN and $ends END marker lines of the project-forge block (one pair at most is expected). Fix it by hand with crontab -e. Nothing was changed."
fi
if [ "$begins" = 1 ]; then
  first=$(grep -n -x -F "$BEGIN" "$work/current" | cut -d: -f1)
  last=$(grep -n -x -F "$END" "$work/current" | cut -d: -f1)
  [ "$first" -lt "$last" ] || die "the END marker of the project-forge block comes before its BEGIN marker. Fix it by hand with crontab -e. Nothing was changed."
fi

# Same lines, with the block replaced in place (or appended, or dropped).
if [ "$mode" = remove ]; then
  : > "$work/block"
fi
awk -v begin="$BEGIN" -v end="$END" -v blockfile="$work/block" '
  function emit(   l) { while ((getline l < blockfile) > 0) print l; close(blockfile); done = 1 }
  $0 == begin { emit(); skipping = 1; next }
  skipping { if ($0 == end) skipping = 0; next }
  { print }
  END { if (!done) emit() }
' "$work/current" > "$work/next"

if cmp -s "$work/current" "$work/next"; then
  log "crontab already up to date (nothing to install or remove), crontab not called."
  exit 0
fi
"$crontab_bin" "$work/next" || die "installing the new crontab failed."
if [ "$mode" = remove ]; then
  log "removed the project-forge block from the crontab."
else
  log "installed the project-forge block in the crontab:"
  cat "$work/block"
fi
