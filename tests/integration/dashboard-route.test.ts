import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Integration tests for GET /api/dashboard.
 *
 * SECURITY NOTE: the route no longer returns the caller's raw `githubPat`.
 * Only two of its three consumers (dashboard/page.tsx, create/page.tsx) need
 * existence, so the route now returns a `githubPatConnected` boolean instead.
 * The settings page, which pre-fills/edits the raw token, reads it from the
 * dedicated GET /api/dashboard/pat endpoint (see dashboard-token-management.test.ts).
 * These tests assert the raw PAT is absent and the boolean is present.
 *
 * Same treatment for API tokens: apiTokens.token is hashed at rest (never
 * queried/selected here in the first place), and this route only ever
 * returns the non-secret `tokenPrefix` display hint, never a raw token.
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

  it("200 happy path returns githubPatConnected: true (never the raw PAT) plus active tokens, when a PAT is set", async () => {
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
          tokenHash: "deadbeef_hash_value_never_returned",
          tokenPrefix: "pf_abc123",
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
      githubPatConnected: true,
    });
    // The raw PAT must never appear anywhere in the response body.
    expect(body.user.githubPat).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ghp_mockedTokenValue");
    expect(body.tokens).toEqual([
      {
        id: "tok-1",
        name: "ci",
        tokenPrefix: "pf_abc123",
        lastUsedAt: lastUsedAt.toISOString(),
        createdAt: createdAt.toISOString(),
      },
    ]);
    // Only a non-secret prefix ever leaves this route — no tokenHash, no
    // full/raw token value anywhere in the response.
    expect(body.tokens[0].token).toBeUndefined();
    expect(body.tokens[0].tokenHash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("deadbeef_hash_value_never_returned");
  });

  it("200 happy path returns githubPatConnected: false when the user has no PAT set", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "u@test.com",
      githubPat: null,
      apiTokens: [],
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({
      id: "user-1",
      email: "u@test.com",
      githubPatConnected: false,
    });
  });
});
