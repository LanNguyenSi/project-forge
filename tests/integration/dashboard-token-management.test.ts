import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";

/**
 * Integration tests for the three dashboard API routes that manage tokens and
 * the GitHub PAT. No live DB or session required — all dependencies are mocked.
 *
 * NOTE on mocking: `@/lib/db` is mocked module-wide with `prisma` swapped for
 * a fake, while other exports (hashApiToken, generateApiToken, createApiToken)
 * stay real via vi.importActual. createApiToken() takes the Prisma client as
 * an explicit parameter (rather than closing over lib/db's own singleton)
 * specifically so it picks up this test's fake `prisma`, not a real one.
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
        findUnique: vi.fn(),
      },
    },
    // Keep the real generateApiToken so we can assert pf_ prefix
  };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { POST as createToken } from "@/app/api/dashboard/tokens/route";
import { DELETE as revokeToken } from "@/app/api/dashboard/tokens/[id]/route";
import { GET as getPat, POST as savePat } from "@/app/api/dashboard/pat/route";
import { decryptGithubPat, encryptGithubPat } from "@/lib/github-pat";

const mGetSession = vi.mocked(getServerSession);

const apiToken = prisma.apiToken as unknown as {
  create: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const user = prisma.user as unknown as {
  update: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
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
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-hash-secret";
  });

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
    apiToken.create.mockImplementation(
      ({ data }: { data: { tokenHash: string; tokenPrefix: string; name: string; userId: string } }) =>
        Promise.resolve({
          id: "tok-new",
          tokenHash: data.tokenHash,
          tokenPrefix: data.tokenPrefix,
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
    // The response must carry the raw token, never a hash or the field name
    // the DB stores it under.
    expect(body.token.tokenHash).toBeUndefined();
  });

  it("persists only the hash + prefix in prisma.apiToken.create, never the raw token", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    apiToken.create.mockResolvedValue({
      id: "tok-x",
      tokenHash: "irrelevant-in-this-assertion",
      tokenPrefix: "pf_test123",
      name: "my-token",
      userId: "user-1",
      createdAt: new Date(),
    });

    const res = await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "my-token" }));
    const body = await res.json();

    expect(apiToken.create).toHaveBeenCalledTimes(1);
    const createArg = apiToken.create.mock.calls[0][0];
    expect(createArg.data.userId).toBe("user-1");
    expect(createArg.data).not.toHaveProperty("token");
    expect(createArg.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createArg.data.tokenPrefix).toBe(body.token.token.slice(0, 10));
    // The exact raw value returned to the caller must never itself appear
    // in what got sent to prisma.apiToken.create.
    expect(JSON.stringify(createArg)).not.toContain(body.token.token);
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
      tokenHash: "mocked-hash-value",
      tokenPrefix: "pf_mine123",
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
// GET /api/dashboard/pat  (settings-only: connection state and kind, never the token)
// ---------------------------------------------------------------------------
describe("GET /api/dashboard/pat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when there is no session", async () => {
    mGetSession.mockResolvedValue(null);

    const res = await getPat();

    expect(res.status).toBe(401);
    expect(user.findUnique).not.toHaveBeenCalled();
  });

  it("404 when the session user is not found in the DB", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue(null);

    const res = await getPat();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
  });

  it("scopes the lookup to the session's own user id", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({ githubPat: "ghp_mine" });

    await getPat();

    expect(user.findUnique).toHaveBeenCalledTimes(1);
    expect(user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { id: true, githubPat: true, sessionsValidAfter: true },
    });
  });

  it("200 reports a manual token as connected without returning it", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({ githubPat: "ghp_ownRawToken" });

    const res = await getPat();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, connected: true, kind: "manual" });
    expect(text).not.toContain("ghp_ownRawToken");
    expect(text).not.toContain("ownRawToken");
  });

  it("200 reports an OAuth token (gho_) as kind oauth without returning it", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({ githubPat: "gho_oauthRawToken" });

    const res = await getPat();
    const text = await res.text();

    expect(JSON.parse(text)).toEqual({ ok: true, connected: true, kind: "oauth" });
    expect(text).not.toContain("oauthRawToken");
  });

  it("derives the kind per prefix: gho_ is oauth, ghp_ and github_pat_ are manual", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    for (const [stored, kind] of [
      ["gho_a", "oauth"],
      ["ghp_a", "manual"],
      ["github_pat_a", "manual"],
    ] as const) {
      user.findUnique.mockResolvedValue({ githubPat: stored });
      const body = await (await getPat()).json();
      expect(body.kind, stored).toBe(kind);
    }
  });

  it("never returns the token when the column holds the encrypted form", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const stored = encryptGithubPat("ghp_storedEncrypted");
    user.findUnique.mockResolvedValue({ id: "user-1", githubPat: stored });

    const text = await (await getPat()).text();

    expect(JSON.parse(text)).toEqual({ ok: true, connected: true, kind: "manual" });
    expect(text).not.toContain("storedEncrypted");
    expect(text).not.toContain(stored);
    expect(text).not.toContain("v1:");
  });

  it("200 reports not connected when the stored token no longer decrypts (key rotated)", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({
      id: "user-1",
      githubPat: encryptGithubPat("ghp_oldKey", { NEXTAUTH_SECRET: "the-previous-secret" }),
    });

    const res = await getPat();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, connected: false, kind: null });
    expect(text).not.toContain("v1:");
  });

  it("200 reports not connected when the user has none set", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({ githubPat: null });

    const res = await getPat();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, connected: false, kind: null });
  });

  it("sends the response with no-store caching", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    user.findUnique.mockResolvedValue({ githubPat: "ghp_x" });

    const res = await getPat();

    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
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

  it("400 for a fine-grained token (github_pat_): the form accepts classic tokens only", async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await savePat(
      jsonReq("http://test/api/dashboard/pat", {
        githubPat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      }),
    );
    expect(res.status).toBe(400);
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
    // Stored encrypted, never as the token itself.
    const stored = user.update.mock.calls[0][0].data.githubPat as string;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("ghp_validClassicToken");
    expect(decryptGithubPat(stored)).toBe("ghp_validClassicToken");
  });
});

// ---------------------------------------------------------------------------
// 500 responses must not echo the thrown error message
// ---------------------------------------------------------------------------
describe("dashboard routes: 500 does not leak error.message", () => {
  const LEAK = "Invalid prisma invocation: column secret_col";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
  });

  async function expectGeneric(res: Response) {
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("prisma");
    expect(text).not.toContain("secret_col");
    expect(JSON.parse(text).details).toMatch(/^An internal error occurred\. Reference: [0-9a-f]{8}$/);
    expect(console.error).toHaveBeenCalled();
  }

  it("POST /api/dashboard/tokens", async () => {
    apiToken.create.mockRejectedValue(new Error(LEAK));
    await expectGeneric(await createToken(jsonReq("http://test/api/dashboard/tokens", { name: "ci" })));
  });

  it("DELETE /api/dashboard/tokens/[id]", async () => {
    apiToken.findFirst.mockRejectedValue(new Error(LEAK));
    const req = new NextRequest("http://test/api/dashboard/tokens/t1", { method: "DELETE" });
    await expectGeneric(await revokeToken(req, { params: Promise.resolve({ id: "t1" }) }));
  });

  it("POST /api/dashboard/pat", async () => {
    user.update.mockRejectedValue(new Error(LEAK));
    await expectGeneric(await savePat(jsonReq("http://test/api/dashboard/pat", { githubPat: "ghp_abc" })));
  });
});
