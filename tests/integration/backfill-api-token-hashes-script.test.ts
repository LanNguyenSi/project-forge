import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Integration coverage for scripts/backfill-api-token-hashes.js's own
 * control flow (expand / --contract / fail-loud), run as a real child
 * process against a real (throwaway, file-based) SQLite DB — not mocked,
 * since the whole point of this script is raw-SQL DDL/DML that a mocked
 * Prisma client can't meaningfully exercise. This is the automated
 * counterpart to the manual verification recorded in the script's own
 * header comment (9 scenarios, run by hand during development).
 *
 * Each test builds its own scratch DB directly via raw SQL through the
 * project's already-generated PrismaClient (never via `prisma db push` /
 * `prisma generate` against a temp schema — that would regenerate the
 * shared node_modules/@prisma/client the rest of the suite depends on).
 */

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "backfill-api-token-hashes.js");
const SECRET = "script-integration-test-secret";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function newDbPath(): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pf-token-migration-"));
  return path.join(tmpDir, "legacy.db");
}

/** Builds a scratch DB matching the pre-fix (plaintext `token` column) shape. */
async function seedLegacyDb(
  dbPath: string,
  tokens: Array<{ id: string; token: string; name: string }>
) {
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  try {
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT, ' +
        '"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        '"updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    );
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "ApiToken" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, ' +
        '"name" TEXT NOT NULL, "userId" TEXT NOT NULL, "revokedAt" DATETIME, ' +
        '"lastUsedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
        'FOREIGN KEY ("userId") REFERENCES "User" ("id"))'
    );
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "ApiToken_token_key" ON "ApiToken"("token")');
    await prisma.$executeRawUnsafe(`INSERT INTO "User" (id, email) VALUES ('user-1', 'u@test.com')`);
    for (const t of tokens) {
      await prisma.$executeRawUnsafe(
        'INSERT INTO "ApiToken" (id, token, name, userId) VALUES (?, ?, ?, ?)',
        t.id,
        t.token,
        t.name,
        "user-1"
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

function openRaw(dbPath: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}

async function columnNames(prisma: PrismaClient): Promise<Set<string>> {
  const cols = await prisma.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("ApiToken")');
  return new Set(cols.map((c) => c.name));
}

async function indexNames(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ApiToken'`
  );
  return new Set(rows.map((r) => r.name));
}

function runScript(dbPath: string, args: string[] = []) {
  return execFileSync("node", [SCRIPT_PATH, ...args], {
    env: { ...process.env, DATABASE_URL: `file:${dbPath}`, API_TOKEN_HASH_SECRET: SECRET },
    encoding: "utf8",
  });
}

describe("scripts/backfill-api-token-hashes.js (real SQLite child-process integration)", () => {
  it("expand: hashes plaintext rows, populates tokenHash/tokenPrefix, and leaves `token` untouched", async () => {
    const dbPath = newDbPath();
    await seedLegacyDb(dbPath, [{ id: "tok-1", token: "pf_realplaintextrandomvalue1", name: "ci" }]);

    const stdout = runScript(dbPath);
    expect(stdout).toContain("Expand done");

    const prisma = openRaw(dbPath);
    try {
      const cols = await columnNames(prisma);
      expect(cols.has("token")).toBe(true);
      expect(cols.has("tokenHash")).toBe(true);
      expect(cols.has("tokenPrefix")).toBe(true);

      const rows = await prisma.$queryRawUnsafe<
        { id: string; token: string; tokenHash: string; tokenPrefix: string }[]
      >('SELECT id, token, tokenHash, tokenPrefix FROM "ApiToken"');
      expect(rows).toHaveLength(1);
      expect(rows[0].token).toBe("pf_realplaintextrandomvalue1");
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].tokenPrefix).toBe("pf_realpla");

      expect(await indexNames(prisma)).toContain("ApiToken_tokenHash_key");
    } finally {
      await prisma.$disconnect();
    }
  });

  it("contract: drops `token` and its legacy index once expand has fully run", async () => {
    const dbPath = newDbPath();
    await seedLegacyDb(dbPath, [{ id: "tok-1", token: "pf_realplaintextrandomvalue1", name: "ci" }]);
    runScript(dbPath);

    const stdout = runScript(dbPath, ["--contract"]);
    expect(stdout).toContain("Contract done");

    const prisma = openRaw(dbPath);
    try {
      const cols = await columnNames(prisma);
      expect(cols.has("token")).toBe(false);
      expect(cols.has("tokenHash")).toBe(true);

      const idx = await indexNames(prisma);
      expect(idx.has("ApiToken_token_key")).toBe(false);
      expect(idx.has("ApiToken_tokenHash_key")).toBe(true);

      const rows = await prisma.$queryRawUnsafe<{ tokenHash: string }[]>(
        'SELECT tokenHash FROM "ApiToken"'
      );
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("both phases are idempotent: re-running expand or contract after contract is a clean no-op", async () => {
    const dbPath = newDbPath();
    await seedLegacyDb(dbPath, [{ id: "tok-1", token: "pf_realplaintextrandomvalue1", name: "ci" }]);
    runScript(dbPath);
    runScript(dbPath, ["--contract"]);

    const reExpand = runScript(dbPath);
    expect(reExpand).toContain("nothing to expand");

    const reContract = runScript(dbPath, ["--contract"]);
    expect(reContract).toContain("already contracted");
  });

  it("contract refuses (exit 1) when expand hasn't populated tokenHash yet", async () => {
    // A fresh legacy DB has no tokenHash column at all — contract must not
    // attempt to drop `token` before expand has run at least once.
    const dbPath = newDbPath();
    await seedLegacyDb(dbPath, [{ id: "tok-1", token: "pf_realvalue", name: "ci" }]);

    let threw = false;
    let stderr = "";
    try {
      runScript(dbPath, ["--contract"]);
    } catch (err) {
      threw = true;
      stderr = (err as { stderr?: string }).stderr ?? "";
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("Run expand");
  });

  it("fail-loud: a row with no plaintext token value blocks expand and the unique index is never created", async () => {
    const dbPath = newDbPath();
    await seedLegacyDb(dbPath, [
      { id: "tok-good", token: "pf_realgoodvalue", name: "ci" },
      { id: "tok-empty", token: "", name: "broken" },
    ]);

    let threw = false;
    let stderr = "";
    try {
      runScript(dbPath);
    } catch (err) {
      threw = true;
      stderr = (err as { stderr?: string }).stderr ?? "";
    }
    expect(threw).toBe(true);
    expect(stderr).toContain("have no plaintext token value");

    const prisma = openRaw(dbPath);
    try {
      // The good row is still hashed even though the run overall failed...
      const rows = await prisma.$queryRawUnsafe<{ id: string; tokenHash: string | null }[]>(
        'SELECT id, tokenHash FROM "ApiToken"'
      );
      const good = rows.find((r) => r.id === "tok-good");
      expect(good?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // ...but the unique index must NOT have been created while any row
      // is left without a hash.
      expect(await indexNames(prisma)).not.toContain("ApiToken_tokenHash_key");
    } finally {
      await prisma.$disconnect();
    }

    // Fixed after removing the bad row: a clean re-run succeeds.
    const fixDb = openRaw(dbPath);
    try {
      await fixDb.$executeRawUnsafe('DELETE FROM "ApiToken" WHERE id = ?', "tok-empty");
    } finally {
      await fixDb.$disconnect();
    }
    const stdout = runScript(dbPath);
    expect(stdout).toContain("Expand done");
  });
});
