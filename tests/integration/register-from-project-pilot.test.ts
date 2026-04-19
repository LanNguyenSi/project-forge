import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Prisma client before importing the route.
vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
      apiToken: { findFirst: vi.fn(), create: vi.fn() },
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
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/auth/register-from-project-pilot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register-from-project-pilot", () => {
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

  it("is idempotent: returns the existing active token on repeat calls", async () => {
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
      token: "pf_existing_token_value",
      userId: "user-existing",
      revokedAt: null,
    });

    const res = await POST(makeReq({ githubAccessToken: "valid" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiToken).toBe("pf_existing_token_value");
    expect(apiToken.create).not.toHaveBeenCalled();
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

  it("never leaks the GitHub access-token in response bodies (including errors)", async () => {
    fetchMock.mockRejectedValue(new GitHubAuthError("401"));
    const res = await POST(makeReq({ githubAccessToken: "super-secret-value-xyz" }));
    const body = await res.text();
    expect(body).not.toContain("super-secret-value-xyz");
  });
});
