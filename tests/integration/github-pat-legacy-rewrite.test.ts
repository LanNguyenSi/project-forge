import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { decryptGithubPat, encryptGithubPat, readGithubPat } from "@/lib/github-pat";

/**
 * A token stored before encryption existed (plaintext, no `v1:` prefix) is
 * rewritten encrypted on its first use, against a real SQLite file built from
 * the committed migrations. The rewrite is a compare-and-swap on the value the
 * caller read, so it is idempotent and never overwrites a token written in
 * between.
 */

const ROOT = path.join(__dirname, "..", "..");
let tmpDir: string;
let db: PrismaClient;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pf-github-pat-"));
  const url = `file:${path.join(tmpDir, "pat.db")}`;
  execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.stubEnv("NEXTAUTH_SECRET", "legacy-rewrite-test-secret");
  await db.user.deleteMany();
  return () => vi.unstubAllEnvs();
});

const stored = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).githubPat;

describe("legacy plaintext githubPat", () => {
  it("is rewritten encrypted on first use, and no plaintext remains", async () => {
    const user = await db.user.create({ data: { email: "legacy@example.com", githubPat: "ghp_legacyPlainToken" } });

    expect(await readGithubPat(user, db)).toBe("ghp_legacyPlainToken");

    const after = await stored(user.id);
    expect(after).toMatch(/^v1:/);
    expect(after).not.toContain("ghp_legacyPlainToken");
    expect(decryptGithubPat(after)).toBe("ghp_legacyPlainToken");
  });

  it("is idempotent: a second use leaves the encrypted value as it is", async () => {
    const user = await db.user.create({ data: { email: "twice@example.com", githubPat: "ghp_twice" } });
    await readGithubPat(user, db);
    const first = await stored(user.id);

    const reread = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await readGithubPat(reread, db)).toBe("ghp_twice");
    expect(await stored(user.id)).toBe(first);
  });

  it("does not overwrite a token written after the legacy value was read", async () => {
    const user = await db.user.create({ data: { email: "race@example.com", githubPat: "ghp_oldPlain" } });
    // A reconnect (or a legacy-row claim) commits between the read and the rewrite.
    const newer = encryptGithubPat("gho_newOwner");
    await db.user.update({ where: { id: user.id }, data: { githubPat: newer } });

    expect(await readGithubPat(user, db)).toBe("ghp_oldPlain");
    expect(await stored(user.id)).toBe(newer);
  });

  it("two concurrent first uses leave one encrypted value that decrypts", async () => {
    const user = await db.user.create({ data: { email: "both@example.com", githubPat: "ghp_concurrent" } });
    const other = new PrismaClient({ datasources: { db: { url: `file:${path.join(tmpDir, "pat.db")}` } } });
    try {
      const results = await Promise.all([readGithubPat(user, db), readGithubPat(user, other)]);
      expect(results).toEqual(["ghp_concurrent", "ghp_concurrent"]);
    } finally {
      await other.$disconnect();
    }
    const after = await stored(user.id);
    expect(after).toMatch(/^v1:/);
    expect(decryptGithubPat(after)).toBe("ghp_concurrent");
  });
});
