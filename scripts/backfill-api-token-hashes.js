#!/usr/bin/env node
/**
 * One-time data migration: hashes existing plaintext ApiToken.token values
 * in place, ahead of deploying the schema/code that removes the plaintext
 * `token` column (see the apiTokens-hash-at-rest fix). Recommended approach
 * over invalidate+re-issue for the general ApiToken population: the
 * plaintext is still present in the DB at migration time, so no user needs
 * to be re-issued a new token / no CI or agent integration gets locked out.
 *
 * This project manages its schema via `prisma db push`, not
 * `prisma migrate` (see docs/ways-of-working.md) — there is no SQL
 * migration file that could carry a data transform, and SQLite has no
 * built-in HMAC/SHA-256 function to do the hashing inside SQL anyway. This
 * script is the out-of-band equivalent: plain Node + raw SQL, so it has no
 * dependency on `prisma generate` having already run against the new
 * schema, and needs no extra devDependency (no ts-node/tsx) to execute.
 *
 * Order of operations for a real deploy:
 *   1. node scripts/backfill-api-token-hashes.js   (this script; idempotent
 *      — safe to re-run; skips rows that already have a tokenHash, and
 *      no-ops entirely once the `token` column is gone)
 *   2. deploy the new app code, then `npx prisma db push`
 *
 * The hashing here MUST stay in lockstep with hashApiToken()/tokenPrefixOf()
 * in lib/db.ts (HMAC-SHA256 hex digest, first 10 chars as the prefix). If
 * those change, update this script to match, or verification will fail for
 * every token that predates the change.
 *
 * Usage:
 *   DATABASE_URL=file:./db/project-forge.db \
 *   API_TOKEN_HASH_SECRET=... (or rely on NEXTAUTH_SECRET) \
 *   node scripts/backfill-api-token-hashes.js
 */
const { PrismaClient } = require("@prisma/client");
const { createHmac } = require("crypto");

const secret = process.env.API_TOKEN_HASH_SECRET || process.env.NEXTAUTH_SECRET;
if (!secret) {
  console.error(
    "API_TOKEN_HASH_SECRET (or NEXTAUTH_SECRET) must be set — refusing to hash tokens with no key."
  );
  process.exit(1);
}

function hashApiToken(rawToken) {
  return createHmac("sha256", secret).update(rawToken).digest("hex");
}

function tokenPrefixOf(rawToken) {
  return rawToken.slice(0, 10);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const columns = await prisma.$queryRawUnsafe('PRAGMA table_info("ApiToken")');
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("token")) {
      console.log(
        "No plaintext `token` column on ApiToken — nothing to backfill (already migrated?)."
      );
      return;
    }

    if (!columnNames.has("tokenHash")) {
      await prisma.$executeRawUnsafe('ALTER TABLE "ApiToken" ADD COLUMN "tokenHash" TEXT');
    }
    if (!columnNames.has("tokenPrefix")) {
      await prisma.$executeRawUnsafe('ALTER TABLE "ApiToken" ADD COLUMN "tokenPrefix" TEXT');
    }

    const rows = await prisma.$queryRawUnsafe(
      'SELECT id, token FROM "ApiToken" WHERE tokenHash IS NULL'
    );

    console.log(`Backfilling ${rows.length} token(s)...`);
    for (const row of rows) {
      if (!row.token) continue;
      await prisma.$executeRawUnsafe(
        'UPDATE "ApiToken" SET tokenHash = ?, tokenPrefix = ? WHERE id = ?',
        hashApiToken(row.token),
        tokenPrefixOf(row.token),
        row.id
      );
    }

    // Finalize the schema to match prisma/schema.prisma exactly, so the
    // `prisma db push` that follows sees no destructive diff and no-ops.
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash")'
    );
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "ApiToken_token_key"');
    await prisma.$executeRawUnsafe('ALTER TABLE "ApiToken" DROP COLUMN "token"');

    console.log(
      "Done. `token` column dropped; tokenHash/tokenPrefix populated for all rows."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
