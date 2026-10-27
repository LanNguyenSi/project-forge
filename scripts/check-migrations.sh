#!/bin/sh
# CI guard: the committed migrations must produce exactly prisma/schema.prisma.
# Applies prisma/migrations to a fresh SQLite file with `migrate deploy`, then
# diffs that database against the schema. A schema change without a migration
# leaves a difference, and the script exits non-zero (prisma diff exit 2).
#
#   sh scripts/check-migrations.sh        (npm run db:check-migrations)
#
# Fix a failure with: npx prisma migrate dev --name <what changed>
set -eu

PRISMA="${PRISMA_BIN:-node_modules/.bin/prisma}"
# Migrations are read from the directory next to the schema file.
SCHEMA="${SCHEMA_PATH:-prisma/schema.prisma}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM
url="file:$dir/check.db"

DATABASE_URL="$url" "$PRISMA" migrate deploy --schema "$SCHEMA"
if ! "$PRISMA" migrate diff --from-url "$url" --to-schema-datamodel "$SCHEMA" --exit-code; then
  echo "$SCHEMA and the migrations next to it disagree (differences above): the schema has a change no migration creates, or a migration changes what the schema does not describe." >&2
  echo "Create one: npx prisma migrate dev --name <what changed>, and commit prisma/migrations." >&2
  exit 1
fi
echo "the migrations next to $SCHEMA produce exactly that schema"
