import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

// Mock the Prisma client before importing the route.
vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
      apiToken: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    },
  };
});

vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    fetchGitHubUser: vi.fn(),
  };
});

import { prisma } from "@/lib/db";
import { fetchGitHubUser, GitHubAuthError, GitHubUnreachableError } from "@/lib/github";
import { POST } from "@/app/api/auth/register-from-project-pilot/route";
import { NextRequest } from "next/server";

const fetchMock = vi.mocked(fetchGitHubUser);
const user = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};
const apiToken = prisma.apiToken as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/auth/register-from-project-pilot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register-from-project-pilot", () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-hash-secret";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("400 when githubAccessToken is missing", async () => {
    const res = await POST(makeReq({ githubLogin: "lan" }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when GitHub rejects the token", async () => {
    fetchMock.mockRejectedValue(new GitHubAuthError("401 Unauthorized"));
    const res = await POST(makeReq({ githubAccessToken: "bad" }));
    expect(res.status).toBe(401);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("503 when GitHub is unreachable", async () => {
    fetchMock.mockRejectedValue(new GitHubUnreachableError("ENOTFOUND"));
    const res = await POST(makeReq({ githubAccessToken: "good-but-offline" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("upstream_unavailable");
  });

  it("401 when claimed githubLogin does not match verified identity", async () => {
    fetchMock.mockResolvedValue({
      id: 7,
      login: "actual",
      name: null,
      avatar_url: "",
      email: null,
    });
    const res = await POST(makeReq({
      githubAccessToken: "valid",
      githubLogin: "pretender",
    }));
    expect(res.status).toBe(401);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("provisions a new user and issues an API token on first call", async () => {
    fetchMock.mockResolvedValue({
      id: 42,
      login: "newbie",
      name: "New",
      avatar_url: "",
      email: "new@example.com",
    });
    user.findUnique.mockResolvedValue(null);
    user.create.mockResolvedValue({ id: "user-1" });
    apiToken.findFirst.mockResolvedValue(null);
    apiToken.create.mockResolvedValue({});

    const res = await POST(makeReq({ githubAccessToken: "valid", githubLogin: "newbie" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
    expect(body.githubLogin).toBe("newbie");
    expect(body.apiToken).toMatch(/^pf_/);
    expect(apiToken.create).toHaveBeenCalledTimes(1);
  });

  it("409 when the verified GitHub email collides with a local-auth account (no githubId)", async () => {
    fetchMock.mockResolvedValue({
      id: 123,
      login: "newcomer",
      name: null,
      avatar_url: "",
      email: "victim@example.com",
    });
    // No existing githubId match…
    user.findUnique
      .mockResolvedValueOnce(null)
      // …but a local-auth user already owns the email.
      .mockResolvedValueOnce({
        id: "local-victim",
        email: "victim@example.com",
        passwordHash: "hashed",
        githubId: null,
      });

    const res = await POST(makeReq({ githubAccessToken: "valid" }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("account_exists_link_required");
    // Must NOT have created or mutated a user row.
    expect(user.create).not.toHaveBeenCalled();
    expect(user.update).not.toHaveBeenCalled();
  });

  it("invalidates + re-issues on repeat calls (hash-at-rest means the old raw value can't be recovered)", async () => {
    fetchMock.mockResolvedValue({
      id: 99,
      login: "returning",
      name: null,
      avatar_url: "",
      email: null,
    });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    apiToken.findFirst.mockResolvedValue({
      id: "tok-existing",
      tokenHash: "hash-of-a-token-we-no-longer-have-the-raw-value-for",
      userId: "user-existing",
      revokedAt: null,
    });
    apiToken.update.mockResolvedValue({ id: "tok-existing", revokedAt: new Date() });
    apiToken.create.mockResolvedValue({});

    const res = await POST(makeReq({ githubAccessToken: "valid" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // A fresh token is minted — the old raw value is gone for good.
    expect(body.apiToken).toMatch(/^pf_/);
    expect(apiToken.create).toHaveBeenCalledTimes(1);
    // The old row is revoked, not left dangling as a second active token.
    expect(apiToken.update).toHaveBeenCalledTimes(1);
    expect(apiToken.update.mock.calls[0][0].where.id).toBe("tok-existing");
    expect(apiToken.update.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
  });

  it("403 when ALLOWED_GITHUB_LOGINS is set and login is not in list", async () => {
    process.env.ALLOWED_GITHUB_LOGINS = "authorized-user";
    try {
      fetchMock.mockResolvedValue({
        id: 77,
        login: "stranger",
        name: null,
        avatar_url: "",
        email: null,
      });

      const res = await POST(makeReq({ githubAccessToken: "valid" }));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("forbidden_github_login");
      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
    } finally {
      delete process.env.ALLOWED_GITHUB_LOGINS;
    }
  });

  it("accepts when ALLOWED_GITHUB_LOGINS is set and login matches", async () => {
    process.env.ALLOWED_GITHUB_LOGINS = "ok-user";
    try {
      fetchMock.mockResolvedValue({
        id: 11,
        login: "ok-user",
        name: null,
        avatar_url: "",
        email: null,
      });
      user.findUnique.mockResolvedValue(null);
      user.create.mockResolvedValue({ id: "user-ok", githubLogin: "ok-user" });
      apiToken.findFirst.mockResolvedValue(null);

      const res = await POST(makeReq({ githubAccessToken: "valid" }));

      expect(res.status).toBe(200);
    } finally {
      delete process.env.ALLOWED_GITHUB_LOGINS;
    }
  });

  it("stores the verified OAuth token as githubPat when provisioning a new user", async () => {
    fetchMock.mockResolvedValue({
      id: 42,
      login: "newbie",
      name: "New",
      avatar_url: "",
      email: "new@example.com",
    });
    user.findUnique.mockResolvedValue(null);
    user.create.mockResolvedValue({ id: "user-1" });
    apiToken.findFirst.mockResolvedValue(null);
    apiToken.create.mockResolvedValue({});

    await POST(makeReq({ githubAccessToken: "gho_oauth_token", githubLogin: "newbie" }));

    expect(user.create).toHaveBeenCalledTimes(1);
    expect(user.create.mock.calls[0][0].data.githubPat).toBe("gho_oauth_token");
  });

  it("backfills githubPat on an existing user that has none yet", async () => {
    fetchMock.mockResolvedValue({
      id: 99,
      login: "returning",
      name: null,
      avatar_url: "",
      email: null,
    });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: null,
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    apiToken.findFirst.mockResolvedValue({ id: "tok-existing", tokenHash: "irrelevant-hash", revokedAt: null });

    await POST(makeReq({ githubAccessToken: "gho_fresh_token" }));

    expect(user.update).toHaveBeenCalledTimes(1);
    expect(user.update.mock.calls[0][0].data.githubPat).toBe("gho_fresh_token");
  });

  it("treats an empty-string githubPat as 'none' and backfills it", async () => {
    fetchMock.mockResolvedValue({
      id: 99,
      login: "returning",
      name: null,
      avatar_url: "",
      email: null,
    });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: "",
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    apiToken.findFirst.mockResolvedValue({ id: "tok-existing", tokenHash: "irrelevant-hash", revokedAt: null });

    await POST(makeReq({ githubAccessToken: "gho_backfilled" }));

    expect(user.update.mock.calls[0][0].data.githubPat).toBe("gho_backfilled");
  });

  it("refreshes an existing OAuth (gho_) githubPat so scope upgrades propagate", async () => {
    fetchMock.mockResolvedValue({
      id: 99,
      login: "returning",
      name: null,
      avatar_url: "",
      email: null,
    });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      // Old OAuth token (e.g. without the workflow scope).
      githubPat: "gho_old_narrow_scope_token",
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    apiToken.findFirst.mockResolvedValue({ id: "tok-existing", tokenHash: "irrelevant-hash", revokedAt: null });

    await POST(makeReq({ githubAccessToken: "gho_new_token_with_workflow" }));

    expect(user.update.mock.calls[0][0].data.githubPat).toBe("gho_new_token_with_workflow");
  });

  it("does NOT overwrite a manually-set fine-grained (github_pat_) githubPat", async () => {
    fetchMock.mockResolvedValue({
      id: 99,
      login: "returning",
      name: null,
      avatar_url: "",
      email: null,
    });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: "github_pat_manual_finegrained",
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    apiToken.findFirst.mockResolvedValue({ id: "tok-existing", tokenHash: "irrelevant-hash", revokedAt: null });

    await POST(makeReq({ githubAccessToken: "gho_should_be_ignored" }));

    expect(user.update.mock.calls[0][0].data).not.toHaveProperty("githubPat");
  });

  it("does NOT overwrite a manually-set githubPat on an existing user", async () => {
    fetchMock.mockResolvedValue({
      id: 99,
      login: "returning",
      name: null,
      avatar_url: "",
      email: null,
    });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: "ghp_manual_classic_pat",
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    apiToken.findFirst.mockResolvedValue({ id: "tok-existing", tokenHash: "irrelevant-hash", revokedAt: null });

    await POST(makeReq({ githubAccessToken: "gho_should_be_ignored" }));

    expect(user.update).toHaveBeenCalledTimes(1);
    // No githubPat key in the update payload → the existing PAT is preserved.
    expect(user.update.mock.calls[0][0].data).not.toHaveProperty("githubPat");
  });

  it("never leaks the GitHub access-token in response bodies (including errors)", async () => {
    fetchMock.mockRejectedValue(new GitHubAuthError("401"));
    const res = await POST(makeReq({ githubAccessToken: "super-secret-value-xyz" }));
    const body = await res.text();
    expect(body).not.toContain("super-secret-value-xyz");
  });
});
