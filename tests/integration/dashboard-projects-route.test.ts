import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/dashboard/projects: the signed-in user's recorded projects.
 * The usageLog mock applies the `where` it receives to a small fixture, so the
 * filters (owner, repoUrl set, not deleted) are exercised, not just asserted.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

interface Row {
  id: string;
  userId: string;
  repoUrl: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

const rows: Row[] = [];

function matches(r: Row, where: { userId: string; repoUrl: { not: null }; deletedAt: null }) {
  return (
    r.userId === where.userId &&
    (where.repoUrl.not === null ? r.repoUrl !== null : true) &&
    (where.deletedAt === null ? r.deletedAt === null : true)
  );
}

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      usageLog: {
        findMany: vi.fn(async (args: { where: never; take: number }) =>
          rows
            .filter((r) => matches(r, args.where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, args.take),
        ),
        count: vi.fn(async (args: { where: never }) => rows.filter((r) => matches(r, args.where)).length),
      },
    },
  };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { GET } from "@/app/api/dashboard/projects/route";

const mGetSession = vi.mocked(getServerSession);
const mFindMany = vi.mocked(prisma.usageLog.findMany);

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/dashboard/projects${query}`);
}

function row(id: string, userId: string, over: Partial<Row> = {}, day = 1): Row {
  return {
    id,
    userId,
    repoUrl: `https://github.com/${userId}/${id}`,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, day)),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  mGetSession.mockResolvedValue({ user: { id: "user-1", email: "a@test.com" } } as never);
});

describe("GET /api/dashboard/projects", () => {
  it("401 without a session", async () => {
    mGetSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
    expect(mFindMany).not.toHaveBeenCalled();
  });

  it("401 when the session has no user id", async () => {
    mGetSession.mockResolvedValue({ user: {} } as never);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mFindMany).not.toHaveBeenCalled();
  });

  it("returns only the signed-in user's rows, newest first", async () => {
    rows.push(row("a-old", "user-1", {}, 1), row("b-other", "user-2", {}, 2), row("c-new", "user-1", {}, 3));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["c-new", "a-old"]);
    expect(body.projects[0]).toEqual({
      id: "c-new",
      repoUrl: "https://github.com/user-1/c-new",
      projectName: "c-new",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("does not leak the other user's rows when they sign in instead", async () => {
    rows.push(row("a", "user-1"), row("b", "user-2"));
    mGetSession.mockResolvedValue({ user: { id: "user-2" } } as never);
    const body = await (await GET(req())).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["b"]);
    expect(body.total).toBe(1);
  });

  it("excludes soft-deleted rows", async () => {
    rows.push(row("live", "user-1"), row("gone", "user-1", { deletedAt: new Date() }));
    const body = await (await GET(req())).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["live"]);
    expect(body.total).toBe(1);
  });

  it("excludes in-flight reservations (repoUrl NULL)", async () => {
    rows.push(row("live", "user-1"), row("pending", "user-1", { repoUrl: null }));
    const body = await (await GET(req())).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["live"]);
    expect(body.total).toBe(1);
  });

  it("returns an empty list for a user without rows", async () => {
    const body = await (await GET(req())).json();
    expect(body).toEqual({ ok: true, projects: [], total: 0 });
  });

  describe("limit clamp", () => {
    const cases: Array<[string, string, number]> = [
      ["absent falls back to 20", "", 20],
      ["0 falls back to 20", "?limit=0", 20],
      ["non-numeric falls back to 20", "?limit=abc", 20],
      ["negative clamps up to 1", "?limit=-5", 1],
      ["over the maximum clamps down to 50", "?limit=999", 50],
      ["fractional is truncated", "?limit=7.9", 7],
      ["a value in range is kept", "?limit=30", 30],
    ];
    it.each(cases)("%s", async (_name, query, take) => {
      await GET(req(query));
      expect(mFindMany.mock.calls[0][0]).toMatchObject({ take });
    });

    it("reports the full total while limiting the rows", async () => {
      for (let i = 0; i < 5; i++) rows.push(row(`p${i}`, "user-1", {}, i + 1));
      const body = await (await GET(req("?limit=2"))).json();
      expect(body.projects).toHaveLength(2);
      expect(body.total).toBe(5);
    });
  });
});
