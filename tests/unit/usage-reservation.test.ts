import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  RATE_LIMIT_PER_DAY,
  RESERVATION_TTL_MS,
  reserveUsage,
  confirmUsage,
  releaseUsage,
} from "@/lib/db";

/**
 * The quota is checked and taken in one statement, so it has to be tested
 * against a real SQLite file: a mocked client cannot show that parallel
 * requests do not all pass the count. The schema comes from the committed
 * migrations (`prisma migrate deploy`), the same way the container builds it.
 * Separate PrismaClient instances give separate connections to the one file.
 */

const ROOT = path.join(__dirname, "..", "..");
const HOUR = 60 * 60 * 1000;

let tmpDir: string;
let clients: PrismaClient[];
let db: PrismaClient;

function newClient(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pf-usage-reservation-"));
  const url = `file:${path.join(tmpDir, "usage.db")}`;
  execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  clients = [newClient(url), newClient(url), newClient(url)];
  db = clients[0];
}, 60_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
/** A fresh user and token, so tests do not share quota. */
async function seed(): Promise<{ userId: string; tokenId: string }> {
  const n = ++seq;
  const userId = `user-${n}`;
  const tokenId = `token-${n}`;
  await db.user.create({ data: { id: userId, email: `u${n}@test.com` } });
  await db.apiToken.create({
    data: { id: tokenId, tokenHash: `hash-${n}`, tokenPrefix: "pf_x", name: "t", userId },
  });
  return { userId, tokenId };
}

async function addRows(
  userId: string,
  tokenId: string,
  count: number,
  extra: { repoUrl?: string | null; createdAt?: Date; deletedAt?: Date } = {}
) {
  for (let i = 0; i < count; i++) {
    await db.usageLog.create({
      data: {
        userId,
        tokenId,
        repoUrl: "repoUrl" in extra ? extra.repoUrl : `https://github.com/o/r${i}`,
        createdAt: extra.createdAt,
        deletedAt: extra.deletedAt,
      },
    });
  }
}

describe("reserveUsage: quota boundary", () => {
  it("allows the 10th project (9 used)", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY - 1);
    const r = await reserveUsage(userId, tokenId, db);
    expect(r.allowed).toBe(true);
    expect(await db.usageLog.count({ where: { userId } })).toBe(RATE_LIMIT_PER_DAY);
  });

  it("refuses the 11th project (10 used) and reports the count, without inserting", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY);
    const r = await reserveUsage(userId, tokenId, db);
    expect(r).toEqual({ allowed: false, used: RATE_LIMIT_PER_DAY });
    expect(await db.usageLog.count({ where: { userId } })).toBe(RATE_LIMIT_PER_DAY);
  });

  it("allows the first use (0 used)", async () => {
    const { userId, tokenId } = await seed();
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(true);
  });

  it("does not count rows older than 24 hours", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY, { createdAt: new Date(Date.now() - 25 * HOUR) });
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(true);
  });

  it("counts rows just inside the 24 hour window", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY, { createdAt: new Date(Date.now() - 23 * HOUR) });
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(false);
  });

  it("counts soft-deleted projects, as before", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY, { deletedAt: new Date() });
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(false);
  });

  it("counts only the caller's own rows", async () => {
    const a = await seed();
    const b = await seed();
    await addRows(a.userId, a.tokenId, RATE_LIMIT_PER_DAY);
    expect((await reserveUsage(a.userId, a.tokenId, db)).allowed).toBe(false);
    expect((await reserveUsage(b.userId, b.tokenId, db)).allowed).toBe(true);
  });
});

describe("reserveUsage: parallel requests", () => {
  it("lets exactly 10 of 12 parallel reservations through on one connection pool", async () => {
    const { userId, tokenId } = await seed();
    const results = await Promise.all(
      Array.from({ length: RATE_LIMIT_PER_DAY + 2 }, () => reserveUsage(userId, tokenId, db))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(RATE_LIMIT_PER_DAY);
    expect(results.filter((r) => !r.allowed)).toHaveLength(2);
    expect(await db.usageLog.count({ where: { userId } })).toBe(RATE_LIMIT_PER_DAY);
  });

  it("lets exactly 10 of 45 parallel reservations through across separate connections", async () => {
    const { userId, tokenId } = await seed();
    const results = await Promise.all(
      Array.from({ length: 45 }, (_, i) => reserveUsage(userId, tokenId, clients[i % clients.length]))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(RATE_LIMIT_PER_DAY);
    expect(await db.usageLog.count({ where: { userId } })).toBe(RATE_LIMIT_PER_DAY);
  });

  it("respects rows that already exist when requests race", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, 7);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => reserveUsage(userId, tokenId, clients[i % clients.length]))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(await db.usageLog.count({ where: { userId } })).toBe(RATE_LIMIT_PER_DAY);
  });

  it("hands out distinct reservation ids", async () => {
    const { userId, tokenId } = await seed();
    const results = await Promise.all(Array.from({ length: 5 }, () => reserveUsage(userId, tokenId, db)));
    const ids = results.flatMap((r) => (r.allowed ? [r.reservationId] : []));
    expect(new Set(ids).size).toBe(5);
  });
});

describe("pending reservations", () => {
  it("count against the quota while the request is in flight", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY, { repoUrl: null });
    const r = await reserveUsage(userId, tokenId, db);
    expect(r).toEqual({ allowed: false, used: RATE_LIMIT_PER_DAY });
  });

  it("stop counting after the reservation TTL (a request that died without releasing)", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY, {
      repoUrl: null,
      createdAt: new Date(Date.now() - RESERVATION_TTL_MS - 60_000),
    });
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(true);
  });

  it("do not make an old finished row stop counting (TTL applies to reservations only)", async () => {
    const { userId, tokenId } = await seed();
    await addRows(userId, tokenId, RATE_LIMIT_PER_DAY, {
      createdAt: new Date(Date.now() - RESERVATION_TTL_MS - 60_000),
    });
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(false);
  });
});

describe("releaseUsage / confirmUsage", () => {
  it("a released reservation frees its slot", async () => {
    const { userId, tokenId } = await seed();
    const held = [];
    for (let i = 0; i < RATE_LIMIT_PER_DAY; i++) held.push(await reserveUsage(userId, tokenId, db));
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(false);

    const first = held[0];
    if (!first.allowed) throw new Error("expected a reservation");
    await releaseUsage(first.reservationId, db);
    expect(await db.usageLog.findUnique({ where: { id: first.reservationId } })).toBeNull();
    expect((await reserveUsage(userId, tokenId, db)).allowed).toBe(true);
  });

  it("a failed attempt leaves no row behind", async () => {
    const { userId, tokenId } = await seed();
    const r = await reserveUsage(userId, tokenId, db);
    if (!r.allowed) throw new Error("expected a reservation");
    await releaseUsage(r.reservationId, db);
    expect(await db.usageLog.count({ where: { userId } })).toBe(0);
  });

  it("confirming keeps one row with the published repo and the token", async () => {
    const { userId, tokenId } = await seed();
    const r = await reserveUsage(userId, tokenId, db);
    if (!r.allowed) throw new Error("expected a reservation");
    await confirmUsage(r.reservationId, "https://github.com/o/demo", db);

    const rows = await db.usageLog.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.reservationId,
      userId,
      tokenId,
      repoUrl: "https://github.com/o/demo",
      deletedAt: null,
    });
    expect(Math.abs(rows[0].createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("releasing a confirmed row does nothing: a published project is never given back", async () => {
    const { userId, tokenId } = await seed();
    const r = await reserveUsage(userId, tokenId, db);
    if (!r.allowed) throw new Error("expected a reservation");
    await confirmUsage(r.reservationId, "https://github.com/o/demo", db);
    await releaseUsage(r.reservationId, db);
    expect(await db.usageLog.count({ where: { userId } })).toBe(1);
  });

  it("releasing an unknown id does not throw", async () => {
    await expect(releaseUsage("does-not-exist", db)).resolves.toBeUndefined();
  });

  it("releaseUsage swallows a database error and logs it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      usageLog: { deleteMany: vi.fn().mockRejectedValue(new Error("db down")) },
    } as unknown as Pick<PrismaClient, "usageLog">;
    await expect(releaseUsage("res-1", failing)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
