#!/usr/bin/env node
/**
 * Two-phase (expand/contract) data migration: hashes existing plaintext
 * ApiToken.token values in place, ahead of dropping the plaintext `token`
 * column (see the apiTokens-hash-at-rest fix). Chosen over invalidate+
 * re-issue for the general ApiToken population: the plaintext is still
 * present in the DB at migration time, so no user/agent integration needs
 * to be re-issued a new token or gets locked out.
 *
 * This project manages its schema via `prisma db push`, not `prisma
 * migrate` (see docs/ways-of-working.md) — there is no SQL migration file
 * that could carry a data transform, and SQLite has no built-in HMAC/
 * SHA-256 function to do the hashing inside SQL anyway. This script is the
 * out-of-band equivalent: plain Node + raw SQL, so it has no dependency on
 * `prisma generate` having already run against the new schema, and needs no
 * extra devDependency (no ts-node/tsx) to execute.
 *
 * WHY TWO PHASES: a single-shot script that backfills AND drops the `token`
 * column in one run is only safe to execute while nothing still relies on
 * `token`. This project's deploy runs `npx prisma db push --skip-generate`
 * (Dockerfile CMD) with NO `--accept-data-loss`, and prisma/schema.prisma no
 * longer declares `token` at all, so — verified locally, see below — `db
 * push` REFUSES outright (exits non-zero, container fails to start) if
 * `token` still holds data when it runs. That means contract cannot be a
 * lazy "run it sometime after the new code has been live" step: it has to
 * run in the same cutover as the deploy, strictly between stopping the OLD
 * container (which still reads/writes `token`, so dropping it while that
 * code is live would break every token-authenticated request) and starting
 * the NEW one (whose own `db push` needs `token` already gone to succeed).
 * Splitting into expand (additive, safe for days/weeks alongside the OLD
 * code — do this well ahead of time, no downtime) and contract (destructive,
 * only safe in that cutover window) makes that one required ordering
 * explicit instead of leaving it implicit in a single script.
 *
 * Runbook for a real deploy:
 *   1. node scripts/backfill-api-token-hashes.js            (expand; run
 *      anytime before the deploy, no downtime — purely additive, the OLD
 *      code keeps working against `token` untouched)
 *   2. Stop the OLD container (brief downtime — the same restart window
 *      `docker compose up -d --build` already causes for this project;
 *      not a new downtime requirement).
 *   3. node scripts/backfill-api-token-hashes.js --contract  (contract;
 *      run now, with the OLD code stopped and the NEW code not yet
 *      started — drops `token` and its legacy unique index for good)
 *   4. Start the NEW container. Its own `npx prisma db push` now sees
 *      `token` already gone and is a clean no-op.
 * Both phases are idempotent — safe to re-run, and each is a no-op once its
 * work is already done (including out of order: contract before expand
 * ever ran is treated as "nothing to contract yet" rather than an error, as
 * long as there's no plaintext `token` column to be destructive about).
 *
 * VERIFIED LOCALLY (SQLite, prisma 5.22.0; not run against any prod/real DB
 * — see task rules): seeded a DB on the pre-fix schema with plaintext
 * ApiToken rows, ran expand, confirmed tokenHash/tokenPrefix correctly
 * populated while `token` and its data were untouched. Ran `prisma db push`
 * (the new, token-less schema) against that intermediate expand-only state
 * and confirmed it REFUSES with a data-loss error ("still contains N
 * non-null values") rather than silently dropping data — this is what
 * drove the corrected runbook above. Then ran contract, confirmed `token`
 * and its index were dropped and all data preserved under
 * tokenHash/tokenPrefix (still nullable at the raw-SQL level from the
 * ADD COLUMN, unlike a fresh push's `NOT NULL`), and ran `prisma db push`
 * again: clean no-op, no data-loss prompt, and this version of `db push`
 * does not attempt to tighten that nullable-vs-schema's-NOT-NULL gap into a
 * migration. Also verified idempotency (re-running expand after contract,
 * and re-running contract twice, are both no-ops) and the fail-loud path
 * (seeded a row with an empty-string token; expand hashed the good row,
 * then reported the bad one and exited 1 without creating the unique
 * index; after removing the bad row, a re-run completed cleanly).
 *
 * The hashing here MUST stay in lockstep with hashApiToken()/tokenPrefixOf()
 * in lib/db.ts (HMAC-SHA256 hex digest, first 10 chars as the prefix). If
 * those change, update this script to match, or verification will fail for
 * every token that predates the change. tests/unit/hash-parity.test.ts
 * asserts the two stay identical for a fixed input.
 *
 * Usage:
 *   DATABASE_URL=file:./db/project-forge.db \
 *   API_TOKEN_HASH_SECRET=... (or rely on NEXTAUTH_SECRET) \
 *   node scripts/backfill-api-token-hashes.js [--contract]
 */
const { PrismaClient } = require("@prisma/client");
const { createHmac } = require("crypto");

// Lazy (not computed at module load) so requiring this file for its pure
// helpers — e.g. the hash-parity test — never fails just because the
// importing process hasn't set a hash secret.
function getSecret() {
  const secret = process.env.API_TOKEN_HASH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "API_TOKEN_HASH_SECRET (or NEXTAUTH_SECRET) must be set — refusing to hash tokens with no key."
    );
  }
  return secret;
}

function hashApiToken(rawToken) {
  return createHmac("sha256", getSecret()).update(rawToken).digest("hex");
}

function tokenPrefixOf(rawToken) {
  return rawToken.slice(0, 10);
}

async function getColumnNames(prisma) {
  const columns = await prisma.$queryRawUnsafe('PRAGMA table_info("ApiToken")');
  return new Set(columns.map((c) => c.name));
}

async function countNullTokenHash(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) as c FROM "ApiToken" WHERE tokenHash IS NULL'
  );
  return Number(rows[0].c);
}

/**
 * Additive only: add tokenHash/tokenPrefix (nullable, so this never
 * conflicts with existing rows) and backfill them from the still-present
 * plaintext `token` column. Never touches `token` itself.
 */
async function runExpand(prisma) {
  const columnNames = await getColumnNames(prisma);

  if (!columnNames.has("token")) {
    console.log(
      "No plaintext `token` column on ApiToken — nothing to expand " +
        "(already contracted, or a fresh install that never had one)."
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

  let skippedNullToken = 0;
  console.log(`Backfilling ${rows.length} token(s)...`);
  for (const row of rows) {
    if (!row.token) {
      skippedNullToken++;
      continue;
    }
    await prisma.$executeRawUnsafe(
      'UPDATE "ApiToken" SET tokenHash = ?, tokenPrefix = ? WHERE id = ?',
      hashApiToken(row.token),
      tokenPrefixOf(row.token),
      row.id
    );
  }

  if (skippedNullToken > 0) {
    console.error(
      `ERROR: ${skippedNullToken} ApiToken row(s) have no plaintext token value ` +
        "and could not be hashed. Fix or hard-delete these rows manually, then " +
        "re-run expand. Refusing to create the tokenHash unique index while any " +
        "row would be left without a hash — contract must not run until this is 0."
    );
    process.exit(1);
  }

  // Fail loud rather than silently proceed: re-check from scratch (not just
  // "skippedNullToken === 0" above, which only covers rows seen in *this*
  // run) before creating the unique index that contract's final schema
  // relies on being fully populated.
  const remaining = await countNullTokenHash(prisma);
  if (remaining > 0) {
    console.error(
      `ERROR: ${remaining} ApiToken row(s) still have no tokenHash after backfill — ` +
        "refusing to create the unique index. Investigate before re-running."
    );
    process.exit(1);
  }

  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash")'
  );

  console.log(
    "Expand done. tokenHash/tokenPrefix populated for all rows; `token` column " +
      "untouched, old code keeps working. At deploy time: stop the old " +
      "container, run this script again with --contract, then start the new one."
  );
}

/**
 * Destructive: drops the legacy `token` column and its unique index. Only
 * safe once the new app code (reading tokenHash, not token) is live —
 * see the file header runbook.
 */
async function runContract(prisma) {
  const columnNames = await getColumnNames(prisma);

  if (!columnNames.has("token")) {
    console.log("No plaintext `token` column on ApiToken — already contracted.");
    return;
  }

  if (!columnNames.has("tokenHash")) {
    console.error(
      "ERROR: no tokenHash column found. Run expand (no --contract flag) first."
    );
    process.exit(1);
  }

  const remaining = await countNullTokenHash(prisma);
  if (remaining > 0) {
    console.error(
      `ERROR: ${remaining} ApiToken row(s) still have no tokenHash. Refusing to ` +
        "drop `token` — re-run expand until it reports 0 remaining first."
    );
    process.exit(1);
  }

  // Defensive: (re-)create the index in case expand's own creation was
  // somehow skipped; idempotent either way.
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash")'
  );
  await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "ApiToken_token_key"');
  await prisma.$executeRawUnsafe('ALTER TABLE "ApiToken" DROP COLUMN "token"');

  console.log("Contract done. `token` column and its legacy index are gone.");
}

async function main() {
  const contract = process.argv.includes("--contract");
  const prisma = new PrismaClient();
  try {
    if (contract) {
      await runContract(prisma);
    } else {
      await runExpand(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { hashApiToken, tokenPrefixOf };

// Only run as a side effect when executed directly (`node
// scripts/backfill-api-token-hashes.js`), not when required by a test that
// just wants the pure hashApiToken/tokenPrefixOf helpers for a parity check
// — requiring this file must not open a DB connection.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
