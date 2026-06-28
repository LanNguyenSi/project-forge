import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the three dashboard API routes that manage tokens and
 * the GitHub PAT. No live DB or session required — all dependencies are mocked.
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
      apiToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      user: {
        update: vi.fn(),
      },
    },
    // Keep the real generateApiToken so we can assert pf_ prefix
  };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { POST as createToken } from "@/app/api/dashboard/tokens/route";
import { DELETE as revokeToken } from "@/app/api/dashboard/tokens/[id]/route";
import { POST as savePat } from "@/app/api/dashboard/pat/route";

const mGetSession = vi.mocked(getServerSession);

const apiToken = prisma.apiToken as unknown as {
  create: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const user = prisma.user as unknown as {
  update: ReturnType<typeof vi.fn>;
};

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AUTHED_SESSION = { user: { id: "user-1", email: "u@test.com" } };

// ---------------------------------------------------------------------------
// POST /api/dashboard/tokens  (create token)
// ---------------------------------------------------------------------------
describe("POST /api/dashboard/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when session is null (unauthenticated)", async () => {
    mGetSession.mockResolvedValue(null);
    const res = await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "ci" }));
    expect(res.status).toBe(401);
    expect(apiToken.create).not.toHaveBeenCalled();
  });

  it("400 when name is an empty string", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
    expect(apiToken.create).not.toHaveBeenCalled();
  });

  it("400 when name is only whitespace", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "   " }));
    expect(res.status).toBe(400);
    expect(apiToken.create).not.toHaveBeenCalled();
  });

  it("200 on success and returned token starts with pf_", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    apiToken.create.mockImplementation(({ data }: { data: { token: string; name: string; userId: string } }) =>
      Promise.resolve({
        id: "tok-new",
        token: data.token,
        name: data.name,
        userId: data.userId,
        createdAt: new Date(),
      })
    );

    const res = await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "ci-token" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.token.token).toMatch(/^pf_/);
    expect(body.token.name).toBe("ci-token");
  });

  it("creates the token with userId === session.user.id", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    apiToken.create.mockResolvedValue({
      id: "tok-x",
      token: "pf_test",
      name: "my-token",
      userId: "user-1",
      createdAt: new Date(),
    });

    await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "my-token" }));

    expect(apiToken.create).toHaveBeenCalledTimes(1);
    const createArg = apiToken.create.mock.calls[0][0];
    expect(createArg.data.userId).toBe("user-1");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/dashboard/tokens/[id]  (revoke token)
// ---------------------------------------------------------------------------
describe("DELETE /api/dashboard/tokens/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function revokeReq(id: string) {
    return new NextRequest(`http://test/api/dashboard/tokens/${id}`, {
      method: "DELETE",
    });
  }

  it("401 when session is null (unauthenticated)", async () => {
    mGetSession.mockResolvedValue(null);
    const res = await revokeToken(revokeReq("tok-1"), {
      params: Promise.resolve({ id: "tok-1" }),
    });
    expect(res.status).toBe(401);
    expect(apiToken.findFirst).not.toHaveBeenCalled();
    expect(apiToken.update).not.toHaveBeenCalled();
  });

  it("404 when findFirst returns null (IDOR — token belongs to another user)", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    // findFirst with { id, userId: 'user-1' } returns null because it's user-2's token
    apiToken.findFirst.mockResolvedValue(null);

    const res = await revokeToken(revokeReq("tok-other"), {
      params: Promise.resolve({ id: "tok-other" }),
    });

    expect(res.status).toBe(404);
    // Critical: update must NOT be called when token not found
    expect(apiToken.update).not.toHaveBeenCalled();
  });

  it("IDOR guard: findFirst query carries userId === session.user.id", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    apiToken.findFirst.mockResolvedValue(null);

    await revokeToken(revokeReq("tok-any"), {
      params: Promise.resolve({ id: "tok-any" }),
    });

    const findFirstArg = apiToken.findFirst.mock.calls[0]?.[0];
    expect(findFirstArg?.where?.userId).toBe("user-1");
    expect(findFirstArg?.where?.id).toBe("tok-any");
  });

  it("200 and sets revokedAt when token belongs to the authenticated user", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    apiToken.findFirst.mockResolvedValue({
      id: "tok-mine",
      token: "pf_mine",
      userId: "user-1",
      revokedAt: null,
    });
    apiToken.update.mockResolvedValue({ id: "tok-mine", revokedAt: new Date() });

    const res = await revokeToken(revokeReq("tok-mine"), {
      params: Promise.resolve({ id: "tok-mine" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(apiToken.update).toHaveBeenCalledTimes(1);
    const updateArg = apiToken.update.mock.calls[0][0];
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// POST /api/dashboard/pat  (save GitHub PAT)
// ---------------------------------------------------------------------------
describe("POST /api/dashboard/pat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when session is null (unauthenticated)", async () => {
    mGetSession.mockResolvedValue(null);
    const res = await savePat(jsonReq("http://test/api/dashboard/pat", { githubPat: "ghp_valid" }));
    expect(res.status).toBe(401);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("400 when githubPat does not start with 'ghp_'", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await savePat(jsonReq("http://test/api/dashboard/pat", { githubPat: "invalid_token" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("400 when githubPat is missing", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await savePat(jsonReq("http://test/api/dashboard/pat", {}));
    expect(res.status).toBe(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("400 when githubPat is an empty string (no prefix)", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await savePat(jsonReq("http://test/api/dashboard/pat", { githubPat: "" }));
    expect(res.status).toBe(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("400 when githubPat starts with 'gho_' (fine-grained PAT rejected by guard)", async () => {
    // Note: this test documents a known limitation — fine-grained PATs starting
    // with 'github_pat_' are also rejected by the current 'ghp_' prefix check.
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await savePat(jsonReq("http://test/api/dashboard/pat", { githubPat: "gho_oauth123" }));
    expect(res.status).toBe(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("200 on valid 'ghp_' prefixed token", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.update.mockResolvedValue({ id: "user-1" });

    const res = await savePat(jsonReq("http://test/api/dashboard/pat", { githubPat: "ghp_validClassicToken" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(user.update).toHaveBeenCalledTimes(1);
  });
});
