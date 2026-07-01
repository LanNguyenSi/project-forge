import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Integration tests for GET /api/dashboard.
 *
 * SECURITY NOTE (resolved, do not re-litigate): the route intentionally
 * returns the caller's own `githubPat` in the response body — this is the
 * owner viewing their own PAT, and the settings page relies on it. These
 * tests assert that value is present, not scrub it.
 */

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
    },
  };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { GET } from "@/app/api/dashboard/route";

const mGetSession = vi.mocked(getServerSession);

const user = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};

const AUTHED_SESSION = { user: { id: "user-1", email: "u@test.com" } };

describe("GET /api/dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when there is no session", async () => {
    mGetSession.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(user.findUnique).not.toHaveBeenCalled();
  });

  it("401 when session exists but has no user.id", async () => {
    mGetSession.mockResolvedValue({ user: {} } as never);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(user.findUnique).not.toHaveBeenCalled();
  });

  it("404 when the session user is not found in the DB", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
  });

  it("queries prisma.user.findUnique with the session's user id and the ACTIVE-tokens-only include", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "u@test.com",
      githubPat: "ghp_mockedTokenValue",
      apiTokens: [],
    });

    await GET();

    expect(user.findUnique).toHaveBeenCalledTimes(1);
    expect(user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      include: {
        apiTokens: {
          where: { revokedAt: null },
          orderBy: { createdAt: "desc" },
        },
      },
    });
  });

  it("200 happy path returns the user (including raw githubPat, per the resolved decision) and their active tokens", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const lastUsedAt = new Date("2026-01-02T00:00:00.000Z");
    user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "u@test.com",
      githubPat: "ghp_mockedTokenValue",
      apiTokens: [
        {
          id: "tok-1",
          name: "ci",
          token: "pf_abc123",
          lastUsedAt,
          createdAt,
        },
      ],
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user).toEqual({
      id: "user-1",
      email: "u@test.com",
      githubPat: "ghp_mockedTokenValue",
    });
    // Resolved decision: raw PAT IS present in the owner's own dashboard response.
    expect(body.user.githubPat).toBe("ghp_mockedTokenValue");
    expect(body.tokens).toEqual([
      {
        id: "tok-1",
        name: "ci",
        token: "pf_abc123",
        lastUsedAt: lastUsedAt.toISOString(),
        createdAt: createdAt.toISOString(),
      },
    ]);
  });
});
