import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from "vitest";

// Mock the Prisma client before importing the route.
vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  const mockPrisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    apiToken: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  } = {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    apiToken: { create: vi.fn(), updateMany: vi.fn() },
    // Interactive-transaction mock: just runs the callback against the same
    // mocked client, mirroring Prisma's real $transaction(async (tx) => ...)
    // shape closely enough for these unit-style tests.
    $transaction: vi.fn((fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma)),
  };
  return {
    ...actual,
    prisma: mockPrisma,
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
import { decryptGithubPat, encryptGithubPat } from "@/lib/github-pat";
import { NextRequest } from "next/server";

const fetchMock = vi.mocked(fetchGitHubUser);
const user = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
const apiToken = prisma.apiToken as unknown as {
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};

// GET /user/emails (the verified-address lookup) is the only fetch the route
// makes itself; fetchGitHubUser is mocked above. The default answer is an empty
// address list: GitHub answered and lists nothing as verified.
type ListedEmail = { email: string; verified: boolean; primary?: boolean };
const emailsFetch = vi.fn();
function githubLists(list: ListedEmail[]) {
  emailsFetch.mockImplementation(async () => new Response(JSON.stringify(list), { status: 200 }));
}
function githubEmailLookupFails() {
  emailsFetch.mockImplementation(async () => new Response("{}", { status: 502 }));
}

function uniqueViolation(target: string[]) {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
}

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
    // mockReset (not only clear): earlier tests queue mockResolvedValueOnce
    // answers and set implementations that must not leak into the next test.
    emailsFetch.mockReset();
    githubLists([]);
    vi.stubGlobal("fetch", emailsFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    apiToken.create.mockResolvedValue({});

    const res = await POST(makeReq({ githubAccessToken: "valid", githubLogin: "newbie" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
    expect(body.githubLogin).toBe("newbie");
    expect(body.apiToken).toMatch(/^pf_/);
    expect(apiToken.create).toHaveBeenCalledTimes(1);
  });

  describe("when the GitHub email is held by another row", () => {
    const ghUser = { id: 123, login: "newcomer", name: null, avatar_url: "", email: "victim@example.com" };
    const passwordRow = { id: "local-victim", email: "victim@example.com", passwordHash: "hashed", githubId: null };

    // These cases are about a row holding an address GitHub lists as verified
    // for the identity: the owner of the address is the one calling.
    beforeEach(() => githubLists([{ email: "victim@example.com", verified: true, primary: true }]));

    // findUnique is asked by githubId, then by the GitHub email, then (only
    // for a password row) by the placeholder.
    function lookups(...answers: unknown[]) {
      for (const answer of answers) user.findUnique.mockResolvedValueOnce(answer);
      user.findUnique.mockResolvedValue(null);
    }

    it("gives the identity its own row under the placeholder email when a password account (no githubId) holds the email", async () => {
      fetchMock.mockResolvedValue(ghUser);
      lookups(null, passwordRow, null);
      user.create.mockResolvedValue({ id: "user-new" });
      apiToken.create.mockResolvedValue({});

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe("user-new");
      expect(body.apiToken).toMatch(/^pf_/);
      expect(user.create).toHaveBeenCalledTimes(1);
      const data = user.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ githubId: "123", githubLogin: "newcomer", email: "github-123@noreply" });
      expect(decryptGithubPat(data.githubPat)).toBe("gho_owner");
      // The password row is neither written nor handed a token, and the new
      // token belongs to the new row.
      expect(user.update).not.toHaveBeenCalled();
      expect(user.updateMany).not.toHaveBeenCalled();
      // The last lookup asks the placeholder, not the GitHub email again.
      expect(user.findUnique.mock.calls.map((c) => c[0].where)).toEqual([
        { githubId: "123" },
        { email: "victim@example.com" },
        { email: "github-123@noreply" },
      ]);
      expect(apiToken.updateMany.mock.calls[0][0].where).toMatchObject({ userId: "user-new" });
      expect(apiToken.create.mock.calls[0][0].data).toMatchObject({ userId: "user-new" });
    });

    it("matches that row by githubId on the next call and keeps its email while the GitHub email is held by the password account", async () => {
      fetchMock.mockResolvedValue(ghUser);
      // by githubId and by the placeholder email: the identity row; by the
      // GitHub email: the password account.
      const identityRow = { id: "user-new", githubId: "123", email: "github-123@noreply", githubPat: null };
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string; email?: string } }) => {
        if (where.githubId === "123" || where.email === "github-123@noreply") return identityRow;
        if (where.email === "victim@example.com") return passwordRow;
        return null;
      });
      user.update.mockResolvedValue({ id: "user-new" });
      apiToken.create.mockResolvedValue({});

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).toHaveBeenCalledTimes(1);
      const call = user.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: "user-new" });
      expect(call.data.email).toBe("github-123@noreply");
      expect(apiToken.create.mock.calls[0][0].data).toMatchObject({ userId: "user-new" });
    });

    it("keeps the stored email of an identity row when GitHub reports no public email", async () => {
      fetchMock.mockResolvedValue({ ...ghUser, email: null });
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string; email?: string } }) =>
        where.githubId === "123"
          ? { id: "user-new", githubId: "123", email: "kept@example.com", githubPat: null }
          : null,
      );
      user.update.mockResolvedValue({ id: "user-new" });
      apiToken.create.mockResolvedValue({});

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect(user.update.mock.calls[0][0].data.email).toBe("kept@example.com");
    });

    it("moves an identity row to the GitHub email once no other row holds it", async () => {
      fetchMock.mockResolvedValue(ghUser);
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string; email?: string } }) =>
        where.githubId === "123"
          ? { id: "user-new", githubId: "123", email: "github-123@noreply", githubPat: null }
          : null,
      );
      user.update.mockResolvedValue({ id: "user-new" });
      apiToken.create.mockResolvedValue({});

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect(user.update.mock.calls[0][0].data.email).toBe("victim@example.com");
    });

    it("409 when a password-less row (an older GitHub-only sign-in) holds the email and has no githubId", async () => {
      fetchMock.mockResolvedValue(ghUser);
      lookups(null, { id: "legacy", email: "victim@example.com", passwordHash: null, githubId: null });

      const res = await POST(makeReq({ githubAccessToken: "valid" }));

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("account_exists_link_required");
      // Must NOT have created or mutated a user row.
      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
    });

    it("409 when a password account holds the email and a legacy row without githubId already sits on the placeholder", async () => {
      fetchMock.mockResolvedValue(ghUser);
      lookups(null, passwordRow, { id: "legacy", email: "github-123@noreply", passwordHash: null, githubId: null });

      const res = await POST(makeReq({ githubAccessToken: "valid" }));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("account_exists_link_required");
      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
    });

    it("does not divert a password account that already has another githubId (create under the GitHub email, as before)", async () => {
      fetchMock.mockResolvedValue(ghUser);
      lookups(null, { ...passwordRow, githubId: "999" });
      user.create.mockResolvedValue({ id: "user-new" });
      apiToken.create.mockResolvedValue({});

      await POST(makeReq({ githubAccessToken: "valid" }));

      expect(user.create.mock.calls[0][0].data.email).toBe("victim@example.com");
    });
  });

  describe("the email a row is keyed on comes from GitHub's verified list", () => {
    const gh = (email: string | null) => ({ id: 123, login: "newcomer", name: null, avatar_url: "", email });
    const placeholder = "github-123@noreply";

    function noRowsAnywhere() {
      user.findUnique.mockResolvedValue(null);
      user.create.mockResolvedValue({ id: "user-new" });
      apiToken.create.mockResolvedValue({});
    }
    const lookedUp = () => user.findUnique.mock.calls.map((c) => c[0].where);

    it("keys a new row on a public email that GitHub lists as verified (lowercased, matched without regard to case)", async () => {
      fetchMock.mockResolvedValue(gh("Verified@Example.com"));
      githubLists([{ email: "verified@example.COM", verified: true }]);
      noRowsAnywhere();

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect(user.create.mock.calls[0][0].data.email).toBe("verified@example.com");
      expect(lookedUp()).toEqual([{ githubId: "123" }, { email: "verified@example.com" }]);
      // The lookup is made with the caller's own token.
      const init = emailsFetch.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gho_owner");
    });

    it("an unverified public email is neither looked up nor stored: the row gets the placeholder", async () => {
      fetchMock.mockResolvedValue(gh("victim@example.com"));
      githubLists([{ email: "victim@example.com", verified: false, primary: true }]);
      noRowsAnywhere();

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect(user.create.mock.calls[0][0].data.email).toBe(placeholder);
      expect(lookedUp()).toEqual([{ githubId: "123" }]);
    });

    it("a public email that GitHub does not list at all gets the placeholder", async () => {
      fetchMock.mockResolvedValue(gh("victim@example.com"));
      githubLists([{ email: "other@example.com", verified: true, primary: true }]);
      noRowsAnywhere();

      await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(user.create.mock.calls[0][0].data.email).toBe(placeholder);
    });

    it("with no public email, keys the row on the verified primary address (lowercased)", async () => {
      fetchMock.mockResolvedValue(gh(null));
      githubLists([
        { email: "second@example.com", verified: true },
        { email: "Primary@Example.com", verified: true, primary: true },
      ]);
      noRowsAnywhere();

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect(user.create.mock.calls[0][0].data.email).toBe("primary@example.com");
    });

    it("with no public email and no verified primary address, the row gets the placeholder", async () => {
      fetchMock.mockResolvedValue(gh(null));
      githubLists([{ email: "primary@example.com", verified: false, primary: true }]);
      noRowsAnywhere();

      await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(user.create.mock.calls[0][0].data.email).toBe(placeholder);
    });

    it.each([
      ["a public email", "victim@example.com"],
      ["no public email", null],
    ])("503 upstream_unavailable and nothing written when GitHub cannot list the emails (%s)", async (_label, email) => {
      fetchMock.mockResolvedValue(gh(email));
      githubEmailLookupFails();
      noRowsAnywhere();

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("upstream_unavailable");
      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(user.updateMany).not.toHaveBeenCalled();
      expect(apiToken.updateMany).not.toHaveBeenCalled();
      expect(apiToken.create).not.toHaveBeenCalled();
    });

    it("503 and nothing written when the email request itself fails", async () => {
      fetchMock.mockResolvedValue(gh("victim@example.com"));
      emailsFetch.mockRejectedValue(new Error("ECONNRESET"));
      noRowsAnywhere();

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(503);
      expect(user.create).not.toHaveBeenCalled();
    });

    it("409, not 500, when another identity's row already holds the verified address", async () => {
      fetchMock.mockResolvedValue(gh("victim@example.com"));
      githubLists([{ email: "victim@example.com", verified: true }]);
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string; email?: string } }) =>
        where.email === "victim@example.com"
          ? { id: "attacker", email: "victim@example.com", passwordHash: null, githubId: "555" }
          : null,
      );
      user.create.mockRejectedValue(uniqueViolation(["email"]));

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("account_exists_link_required");
      expect(user.create).toHaveBeenCalledTimes(1);
      expect(user.update).not.toHaveBeenCalled();
      expect(apiToken.create).not.toHaveBeenCalled();
    });

    it("a create that loses the race on the githubId re-reads that row and continues as an update (token minted, email untouched)", async () => {
      fetchMock.mockResolvedValue(gh(null));
      githubLists([]);
      const raced = { id: "user-raced", githubId: "123", email: placeholder, githubPat: null };
      let githubIdLookups = 0;
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string; email?: string } }) => {
        if (where.githubId === "123") return githubIdLookups++ === 0 ? null : raced;
        return null;
      });
      user.create.mockRejectedValue(uniqueViolation(["githubId"]));
      user.update.mockResolvedValue({ id: "user-raced" });
      apiToken.create.mockResolvedValue({});

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(200);
      expect((await res.json()).userId).toBe("user-raced");
      expect(user.create).toHaveBeenCalledTimes(1);
      expect(githubIdLookups).toBe(2);
      expect(user.update).toHaveBeenCalledTimes(1);
      const call = user.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: "user-raced" });
      expect(call.data.email).toBe(placeholder);
      expect(decryptGithubPat(call.data.githubPat)).toBe("gho_owner");
      expect(apiToken.create.mock.calls[0][0].data).toMatchObject({ userId: "user-raced" });
    });

    it("answers 409 when the create fails on the email and no row has the githubId (re-read finds nothing)", async () => {
      fetchMock.mockResolvedValue(gh(null));
      githubLists([]);
      noRowsAnywhere();
      user.create.mockRejectedValue(uniqueViolation(["email"]));

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("account_exists_link_required");
      expect(user.update).not.toHaveBeenCalled();
    });

    it("answers 409 when the update of the re-read row hits a unique violation as well", async () => {
      fetchMock.mockResolvedValue(gh(null));
      githubLists([]);
      let githubIdLookups = 0;
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string } }) =>
        where.githubId === "123" && githubIdLookups++ > 0
          ? { id: "user-raced", githubId: "123", email: placeholder, githubPat: null }
          : null,
      );
      user.create.mockRejectedValue(uniqueViolation(["githubId"]));
      user.update.mockRejectedValue(uniqueViolation(["email"]));

      const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

      expect(res.status).toBe(409);
    });

    it("any other create error is not turned into a 409 or a retry, even when a row with the githubId exists by then", async () => {
      fetchMock.mockResolvedValue(gh(null));
      githubLists([]);
      let githubIdLookups = 0;
      user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string } }) =>
        where.githubId === "123" && githubIdLookups++ > 0
          ? { id: "user-raced", githubId: "123", email: placeholder, githubPat: null }
          : null,
      );
      user.create.mockRejectedValue(new Error("database is locked"));

      await expect(POST(makeReq({ githubAccessToken: "gho_owner" }))).rejects.toThrow("database is locked");
      expect(githubIdLookups).toBe(1);
      expect(user.update).not.toHaveBeenCalled();
      expect(apiToken.create).not.toHaveBeenCalled();
    });

    describe("an existing identity row", () => {
      const identity = { id: "user-new", githubId: "123", email: "old@example.com", githubPat: null };
      function identityOnly() {
        user.findUnique.mockImplementation(async ({ where }: { where: { githubId?: string } }) =>
          where.githubId === "123" ? identity : null,
        );
        user.update.mockResolvedValue({ id: "user-new" });
        apiToken.create.mockResolvedValue({});
      }

      it("adopts a new public email only when GitHub lists it as verified", async () => {
        fetchMock.mockResolvedValue(gh("New@Example.com"));
        githubLists([{ email: "new@example.com", verified: true }]);
        identityOnly();

        const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

        expect(res.status).toBe(200);
        expect(user.update.mock.calls[0][0].data.email).toBe("new@example.com");
      });

      it("keeps the old email when the new public email is not verified", async () => {
        fetchMock.mockResolvedValue(gh("new@example.com"));
        githubLists([{ email: "new@example.com", verified: false }]);
        identityOnly();

        const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

        expect(res.status).toBe(200);
        expect(user.update.mock.calls[0][0].data.email).toBe("old@example.com");
      });

      it("503 and no update when the new public email cannot be checked", async () => {
        fetchMock.mockResolvedValue(gh("new@example.com"));
        githubEmailLookupFails();
        identityOnly();

        const res = await POST(makeReq({ githubAccessToken: "gho_owner" }));

        expect(res.status).toBe(503);
        expect(user.update).not.toHaveBeenCalled();
        expect(apiToken.create).not.toHaveBeenCalled();
      });

      it("does not ask GitHub when the public email is the stored one or absent", async () => {
        fetchMock.mockResolvedValue(gh("old@example.com"));
        identityOnly();
        await POST(makeReq({ githubAccessToken: "gho_owner" }));
        fetchMock.mockResolvedValue(gh(null));
        await POST(makeReq({ githubAccessToken: "gho_owner" }));

        expect(emailsFetch).not.toHaveBeenCalled();
        expect(user.update.mock.calls.map((c) => c[0].data.email)).toEqual(["old@example.com", "old@example.com"]);
      });
    });
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
    apiToken.updateMany.mockResolvedValue({ count: 1 });
    apiToken.create.mockResolvedValue({});

    const res = await POST(makeReq({ githubAccessToken: "valid" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // A fresh token is minted — the old raw value is gone for good.
    expect(body.apiToken).toMatch(/^pf_/);
    expect(apiToken.create).toHaveBeenCalledTimes(1);
    // Any currently-active project-pilot token(s) for this user are revoked
    // in bulk (not read-then-update-by-id), so a concurrent racing call
    // can't leave two tokens active — see the route's inline comment.
    expect(apiToken.updateMany).toHaveBeenCalledTimes(1);
    const revokeArg = apiToken.updateMany.mock.calls[0][0];
    expect(revokeArg.where).toEqual({
      userId: "user-existing",
      name: "project-pilot",
      revokedAt: null,
    });
    expect(revokeArg.data.revokedAt).toBeInstanceOf(Date);
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
    apiToken.create.mockResolvedValue({});

    await POST(makeReq({ githubAccessToken: "gho_oauth_token", githubLogin: "newbie" }));

    expect(user.create).toHaveBeenCalledTimes(1);
    expect(decryptGithubPat(user.create.mock.calls[0][0].data.githubPat)).toBe("gho_oauth_token");
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

    await POST(makeReq({ githubAccessToken: "gho_fresh_token" }));

    expect(user.update).toHaveBeenCalledTimes(1);
    expect(decryptGithubPat(user.update.mock.calls[0][0].data.githubPat)).toBe("gho_fresh_token");
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

    await POST(makeReq({ githubAccessToken: "gho_backfilled" }));

    expect(decryptGithubPat(user.update.mock.calls[0][0].data.githubPat)).toBe("gho_backfilled");
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

    await POST(makeReq({ githubAccessToken: "gho_new_token_with_workflow" }));

    expect(decryptGithubPat(user.update.mock.calls[0][0].data.githubPat)).toBe("gho_new_token_with_workflow");
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

    await POST(makeReq({ githubAccessToken: "gho_should_be_ignored" }));

    expect(user.update).toHaveBeenCalledTimes(1);
    // No githubPat key in the update payload → the existing PAT is preserved.
    expect(user.update.mock.calls[0][0].data).not.toHaveProperty("githubPat");
  });

  it("stores the token encrypted, never as the token itself", async () => {
    fetchMock.mockResolvedValue({ id: 77, login: "newbie", name: null, avatar_url: "", email: null });
    user.findUnique.mockResolvedValue(null);
    user.create.mockResolvedValue({ id: "user-new" });

    await POST(makeReq({ githubAccessToken: "gho_oauth_token" }));

    const stored = user.create.mock.calls[0][0].data.githubPat as string;
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("gho_oauth_token");
  });

  it("refreshes an encrypted OAuth (gho_) githubPat", async () => {
    fetchMock.mockResolvedValue({ id: 99, login: "returning", name: null, avatar_url: "", email: null });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: encryptGithubPat("gho_old_encrypted"),
    });
    user.update.mockResolvedValue({ id: "user-existing" });

    await POST(makeReq({ githubAccessToken: "gho_new_after_encryption" }));

    const stored = user.update.mock.calls[0][0].data.githubPat as string;
    expect(stored).toMatch(/^v1:/);
    expect(decryptGithubPat(stored)).toBe("gho_new_after_encryption");
  });

  it("preserves an encrypted manual (ghp_) githubPat", async () => {
    fetchMock.mockResolvedValue({ id: 99, login: "returning", name: null, avatar_url: "", email: null });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: encryptGithubPat("ghp_manual_encrypted"),
    });
    user.update.mockResolvedValue({ id: "user-existing" });

    await POST(makeReq({ githubAccessToken: "gho_should_be_ignored" }));

    expect(user.update.mock.calls[0][0].data).not.toHaveProperty("githubPat");
  });

  it("replaces a stored token that no longer decrypts (key rotated) as if none were set", async () => {
    fetchMock.mockResolvedValue({ id: 99, login: "returning", name: null, avatar_url: "", email: null });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: encryptGithubPat("ghp_manual_old_key", { NEXTAUTH_SECRET: "the-previous-secret" }),
    });
    user.update.mockResolvedValue({ id: "user-existing" });

    await POST(makeReq({ githubAccessToken: "gho_reconnected" }));

    expect(decryptGithubPat(user.update.mock.calls[0][0].data.githubPat)).toBe("gho_reconnected");
  });

  it("re-encrypts a preserved legacy plaintext manual PAT in place", async () => {
    fetchMock.mockResolvedValue({ id: 99, login: "returning", name: null, avatar_url: "", email: null });
    user.findUnique.mockResolvedValue({
      id: "user-existing",
      githubId: "99",
      email: null,
      githubPat: "ghp_legacy_plain",
    });
    user.update.mockResolvedValue({ id: "user-existing" });
    user.updateMany.mockResolvedValue({ count: 1 });

    await POST(makeReq({ githubAccessToken: "gho_should_be_ignored" }));

    expect(user.updateMany).toHaveBeenCalledTimes(1);
    const args = user.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: "user-existing", githubPat: "ghp_legacy_plain" });
    expect(decryptGithubPat(args.data.githubPat)).toBe("ghp_legacy_plain");
  });

  it("never leaks the GitHub access-token in response bodies (including errors)", async () => {
    fetchMock.mockRejectedValue(new GitHubAuthError("401"));
    const res = await POST(makeReq({ githubAccessToken: "super-secret-value-xyz" }));
    const body = await res.text();
    expect(body).not.toContain("super-secret-value-xyz");
  });
});
