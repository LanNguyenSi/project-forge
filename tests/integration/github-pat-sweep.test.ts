import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { decryptGithubPat, encryptGithubPat, startLegacyGithubPatSweep, sweepLegacyGithubPats } from "@/lib/github-pat";

/**
 * The start-up sweep against a real SQLite file built from the committed
 * migrations: every legacy plaintext githubPat is rewritten encrypted, in
 * batches, an encrypted row and a null row stay as they are, and a second
 * sweep or a reconnect in between is never overwritten.
 */

const ROOT = path.join(__dirname, "..", "..");
const SECRET = "sweep-test-secret";
const ENV = { NEXTAUTH_SECRET: SECRET };
let tmpDir: string;
let url: string;
let db: PrismaClient;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pf-github-pat-sweep-"));
  url = `file:${path.join(tmpDir, "sweep.db")}`;
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

const LEGACY = ["ghp_legacyA", "gho_legacyB", "github_pat_legacyC", "ghp_legacyD", "gho_legacyE"];
let encryptedValue: string;

beforeEach(async () => {
  await db.user.deleteMany();
  for (const [i, token] of LEGACY.entries()) {
    await db.user.create({ data: { id: `legacy-${i}`, email: `l${i}@example.com`, githubPat: token } });
  }
  encryptedValue = encryptGithubPat("ghp_alreadyEncrypted", ENV);
  await db.user.create({ data: { id: "encrypted", email: "e@example.com", githubPat: encryptedValue } });
  await db.user.create({ data: { id: "none", email: "n@example.com", githubPat: null } });
});

async function pats(): Promise<Record<string, string | null>> {
  const rows = await db.user.findMany({ select: { id: true, githubPat: true } });
  return Object.fromEntries(rows.map((r) => [r.id, r.githubPat]));
}

function expectAllLegacyEncrypted(after: Record<string, string | null>) {
  for (const [i, token] of LEGACY.entries()) {
    const stored = after[`legacy-${i}`];
    expect(stored).toMatch(/^v1:/);
    expect(decryptGithubPat(stored, ENV)).toBe(token);
  }
}

describe("sweepLegacyGithubPats", () => {
  it("encrypts every legacy row across several batches and leaves encrypted and null rows as they are", async () => {
    const result = await sweepLegacyGithubPats(db, ENV, 2);

    expect(result).toEqual({ skipped: false, rewritten: LEGACY.length, failed: 0 });
    const after = await pats();
    expectAllLegacyEncrypted(after);
    expect(after.encrypted).toBe(encryptedValue);
    expect(after.none).toBeNull();
  });

  it("is idempotent: a second pass rewrites nothing and changes no value", async () => {
    await sweepLegacyGithubPats(db, ENV, 2);
    const first = await pats();

    expect(await sweepLegacyGithubPats(db, ENV, 2)).toEqual({ skipped: false, rewritten: 0, failed: 0 });
    expect(await pats()).toEqual(first);
  });

  it("two instances sweeping at once leave each row encrypted once, with its own token", async () => {
    const other = new PrismaClient({ datasources: { db: { url } } });
    try {
      const results = await Promise.all([sweepLegacyGithubPats(db, ENV, 2), sweepLegacyGithubPats(other, ENV, 2)]);
      expect(results[0].rewritten + results[1].rewritten).toBe(LEGACY.length);
      expect(results[0].failed + results[1].failed).toBe(0);
    } finally {
      await other.$disconnect();
    }
    const after = await pats();
    expectAllLegacyEncrypted(after);
    expect(after.encrypted).toBe(encryptedValue);
  });

  it("does not overwrite a reconnect that commits after the batch was read", async () => {
    const reconnected = encryptGithubPat("gho_reconnected", ENV);
    let once = true;
    const client = {
      user: {
        findMany: (async (args) => {
          const rows = await db.user.findMany(args as never);
          if (once) {
            once = false;
            await db.user.update({ where: { id: "legacy-0" }, data: { githubPat: reconnected } });
          }
          return rows;
        }) as typeof db.user.findMany,
        updateMany: db.user.updateMany.bind(db.user),
      },
    };

    const result = await sweepLegacyGithubPats(client as never, ENV, 2);

    expect(result.rewritten).toBe(LEGACY.length - 1);
    const after = await pats();
    expect(after["legacy-0"]).toBe(reconnected);
    for (const [i, token] of LEGACY.entries()) {
      if (i === 0) continue;
      expect(decryptGithubPat(after[`legacy-${i}`], ENV)).toBe(token);
    }
  });

  it("is skipped entirely when no key is configured", async () => {
    const before = await pats();
    expect(await sweepLegacyGithubPats(db, { NEXTAUTH_SECRET: "", GITHUB_PAT_ENCRYPTION_KEY: "" }, 2)).toEqual({
      skipped: true,
      rewritten: 0,
      failed: 0,
    });
    expect(await pats()).toEqual(before);
  });
});

describe("startLegacyGithubPatSweep", () => {
  it("returns before the sweep finishes and logs counts only", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = {
      user: {
        findMany: (async (args) => {
          await gate;
          return db.user.findMany(args as never);
        }) as typeof db.user.findMany,
        updateMany: db.user.updateMany.bind(db.user),
      },
    };
    try {
      expect(startLegacyGithubPatSweep(client as never)).toBeUndefined();
      // Nothing written yet: the caller was not held up by the sweep.
      expect((await pats())["legacy-0"]).toBe("ghp_legacyA");
      release();
      await vi.waitFor(() => expect(info).toHaveBeenCalled());
      const line = String(info.mock.calls[0][0]);
      expect(line).toContain(`${LEGACY.length} legacy token(s) encrypted, 0 failed`);
      for (const token of LEGACY) expect(line).not.toContain(token);
    } finally {
      info.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("logs a fixed message without the error text when the query fails", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      user: {
        findMany: async () => {
          throw new Error("SQLITE_BUSY near ghp_legacyA");
        },
        updateMany: db.user.updateMany.bind(db.user),
      },
    };
    try {
      startLegacyGithubPatSweep(client as never);
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      expect(error.mock.calls[0]).toHaveLength(1);
      expect(String(error.mock.calls[0][0])).not.toContain("ghp_legacyA");
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
