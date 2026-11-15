import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the User table: just enough of the Prisma surface the
// GitHub sign-in callback uses, with the unique indexes on email and githubId.
type Row = {
  id: string;
  email: string | null;
  passwordHash: string | null;
  githubId: string | null;
  githubLogin: string | null;
  githubPat: string | null;
  githubOwner: string | null;
};

const { rows, store } = vi.hoisted(() => {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  // The unique indexes on email and githubId, enforced on create, update and
  // updateMany like the database does (NULL never collides).
  const assertUnique = (data: Partial<Row>, selfId?: string) => {
    for (const key of ["email", "githubId"] as const) {
      if (data[key] != null && rows.some((r) => r.id !== selfId && r[key] === data[key])) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
    }
  };
  const store = {
    // Runs after a findUnique has produced its (snapshot) result, so a test
    // can change the stored rows in the window between the read and the write.
    afterFind: null as null | ((where: Record<string, unknown>) => void),
    reset() {
      rows.length = 0;
      seq = 0;
      store.afterFind = null;
    },
    user: {
      // Returns a snapshot, like a database read: later changes to the stored
      // row do not show up in a result already handed out.
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows.find((r) => matches(r, where));
        const snapshot = found ? { ...found } : null;
        store.afterFind?.(where);
        return snapshot;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        assertUnique(data, row.id);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => assertUnique(data, r.id));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        assertUnique(data);
        const row: Row = {
          id: `u${++seq}`,
          email: null,
          passwordHash: null,
          githubId: null,
          githubLogin: null,
          githubPat: null,
          githubOwner: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
    },
  };
  return { rows, store };
});

vi.mock("@/lib/db", () => ({ prisma: { user: store.user } }));

import { authOptions } from "@/lib/auth";

const REFUSED = "/login?error=OAuthAccountNotLinked";

function row(over: Partial<Row>): Row {
  const r: Row = {
    id: `seed${rows.length + 1}`,
    email: null,
    passwordHash: null,
    githubId: null,
    githubLogin: null,
    githubPat: null,
    githubOwner: null,
    ...over,
  };
  rows.push(r);
  return r;
}

type EmailsAnswer =
  | Array<{ email: string; primary?: boolean; verified?: boolean }>
  | { status: number; body?: unknown }
  | "network-error"
  | "not-json";

// Stand-in for GET https://api.github.com/user/emails. By default GitHub
// reports the signed-in email as primary and verified.
const fetchMock = vi.fn();
function answerEmails(answer: EmailsAnswer) {
  fetchMock.mockImplementation(async () => {
    if (answer === "network-error") throw new Error("socket hang up gho_secret_token");
    if (answer === "not-json") return new Response("<html>gho_secret_token</html>", { status: 200 });
    if (Array.isArray(answer)) return new Response(JSON.stringify(answer), { status: 200 });
    return new Response(JSON.stringify(answer.body ?? { message: "gho_secret_token" }), { status: answer.status });
  });
}

async function githubSignIn(opts: {
  id: string;
  email?: string | null;
  token?: string | null;
  login?: string;
  emails?: EmailsAnswer;
}) {
  answerEmails(opts.emails ?? (opts.email ? [{ email: opts.email, primary: true, verified: true }] : []));
  const user = { id: opts.id, email: opts.email === undefined ? null : opts.email };
  const result = await authOptions.callbacks!.signIn!({
    user: user as never,
    account: {
      provider: "github",
      type: "oauth",
      providerAccountId: opts.id,
      access_token: opts.token === null ? undefined : (opts.token ?? "gho_new"),
    } as never,
    profile: (opts.login ? { login: opts.login } : {}) as never,
  });
  return { result, user };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub sign-in account matching", () => {
  it("refuses a password account with the same email and leaves the row untouched", async () => {
    const victim = row({ email: "victim@example.com", passwordHash: "hash", githubPat: "ghp_manual" });
    const before = { ...victim };

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "victim@example.com",
      token: "gho_victim",
      login: "victim",
    });

    expect(result).toBe(REFUSED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(before);
    expect(rows[0].githubPat).toBe("ghp_manual");
    expect(user.id).toBe("1001"); // session id is not rewritten to the foreign row
    expect(store.user.update).not.toHaveBeenCalled();
    expect(store.user.updateMany).not.toHaveBeenCalled();
    expect(store.user.create).not.toHaveBeenCalled();
  });

  it("refuses an email match when the row is linked to another GitHub identity", async () => {
    const other = row({ email: "shared@example.com", githubId: "2002", githubPat: "gho_other" });
    const before = { ...other };

    const { result } = await githubSignIn({ id: "1001", email: "shared@example.com" });

    expect(result).toBe(REFUSED);
    expect(rows).toEqual([before]);
    expect(store.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an email match with a password even when it also has another GitHub identity", async () => {
    const other = row({ email: "both@example.com", passwordHash: "hash", githubId: "2002" });
    const before = { ...other };

    const { result } = await githubSignIn({ id: "1001", email: "both@example.com" });

    expect(result).toBe(REFUSED);
    expect(rows).toEqual([before]);
  });

  it("signs in a row linked to the same GitHub identity and refreshes the token", async () => {
    row({ id: "r1", email: "me@example.com", githubId: "1001", githubPat: "gho_old", githubOwner: "old" });

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "me@example.com",
      token: "gho_fresh",
      login: "me",
    });

    expect(result).toBe(true);
    expect(user.id).toBe("r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubPat: "gho_fresh", githubOwner: "me", githubLogin: "me", githubId: "1001" });
  });

  it("matches by identity when the GitHub email changed, without touching the email", async () => {
    row({ id: "r1", email: "old@example.com", githubId: "1001", githubPat: "gho_old" });

    const { result, user } = await githubSignIn({ id: "1001", email: "new@example.com", token: "gho_fresh" });

    expect(result).toBe(true);
    expect(user.id).toBe("r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "old@example.com", githubPat: "gho_fresh" });
  });

  it("signs in a linked account that also has a password (identity wins over the password flag)", async () => {
    row({ id: "r1", email: "me@example.com", passwordHash: "hash", githubId: "1001" });

    const { result, user } = await githubSignIn({ id: "1001", email: "me@example.com", token: "gho_fresh" });

    expect(result).toBe(true);
    expect(user.id).toBe("r1");
    expect(rows[0].githubPat).toBe("gho_fresh");
    expect(rows[0].passwordHash).toBe("hash");
  });

  it("creates a new user with the GitHub identity for an unknown email", async () => {
    const { result, user } = await githubSignIn({
      id: "1001",
      email: "new@example.com",
      token: "gho_new",
      login: "newbie",
    });

    expect(result).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "new@example.com",
      passwordHash: null,
      githubId: "1001",
      githubLogin: "newbie",
      githubPat: "gho_new",
    });
    expect(user.id).toBe(rows[0].id);
  });

  it("creates a user under a placeholder email when GitHub gives none, and finds it again by identity", async () => {
    const first = await githubSignIn({ id: "1001", email: null, token: "gho_a" });
    expect(first.result).toBe(true);
    expect(rows[0]).toMatchObject({ email: "github-1001@noreply", githubId: "1001", githubPat: "gho_a" });

    const second = await githubSignIn({ id: "1001", email: null, token: "gho_b" });
    expect(second.result).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].githubPat).toBe("gho_b");
  });

  it("claims a legacy GitHub-only row (no githubId, no password) and records the identity", async () => {
    row({ id: "legacy", email: "legacy@example.com", githubPat: "gho_old" });

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      token: "gho_fresh",
      login: "legacy",
    });

    expect(result).toBe(true);
    expect(user.id).toBe("legacy");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubId: "1001", githubPat: "gho_fresh", githubLogin: "legacy" });

    // The next sign-in matches by identity.
    store.user.updateMany.mockClear();
    const again = await githubSignIn({ id: "1001", email: "legacy@example.com", token: "gho_again" });
    expect(again.result).toBe(true);
    expect(rows[0].githubPat).toBe("gho_again");
    expect(store.user.updateMany).not.toHaveBeenCalled();
  });

  it("claims a legacy placeholder-email row", async () => {
    row({ id: "legacy", email: "github-1001@noreply", githubPat: "gho_old" });

    const { result, user } = await githubSignIn({ id: "1001", email: null });

    expect(result).toBe(true);
    expect(user.id).toBe("legacy");
    expect(rows[0].githubId).toBe("1001");
  });

  // The email lookup hands out a snapshot of the legacy row; the stored row
  // changes before the claim runs. The claim goes through the fake's real
  // filtering updateMany, so it is the where clause that must refuse.
  it.each([
    ["a password appears", { passwordHash: "hash" }],
    ["another GitHub identity is linked", { githubId: "2002" }],
  ] as const)("refuses when the legacy row changes between the read and the claim: %s", async (_name, change) => {
    const legacy = row({ id: "legacy", email: "legacy@example.com", githubPat: "gho_old" });
    store.afterFind = (where) => {
      if (where.email === "legacy@example.com") Object.assign(legacy, change);
    };

    const { result, user } = await githubSignIn({ id: "1001", email: "legacy@example.com", token: "gho_x" });

    expect(result).toBe(REFUSED);
    expect(store.user.updateMany).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].githubPat).toBe("gho_old");
    expect(rows[0].githubId).toBe("githubId" in change ? "2002" : null);
    expect(rows[0].passwordHash).toBe("passwordHash" in change ? "hash" : null);
    expect(user.id).toBe("1001");
  });

  it("refuses when the claim hits the githubId unique index (another row got this identity meanwhile)", async () => {
    row({ id: "legacy", email: "legacy@example.com", githubPat: "gho_old" });
    store.afterFind = (where) => {
      // The identity is taken by another row after the identity lookup.
      if (where.email === "legacy@example.com") row({ id: "taken", email: "other@example.com", githubId: "1001" });
    };

    const { result } = await githubSignIn({ id: "1001", email: "legacy@example.com", token: "gho_x" });

    expect(result).toBe(REFUSED);
    expect(rows.find((r) => r.id === "legacy")).toMatchObject({ githubId: null, githubPat: "gho_old" });
  });

  it("rethrows other database errors from the claim", async () => {
    row({ id: "legacy", email: "legacy@example.com" });
    store.user.updateMany.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    await expect(githubSignIn({ id: "1001", email: "legacy@example.com" })).rejects.toThrow("db down");
  });

  it("refuses when a concurrent sign-in created the row first (unique violation on create)", async () => {
    store.user.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });

    const { result } = await githubSignIn({ id: "1001", email: "race@example.com" });

    expect(result).toBe(REFUSED);
  });

  it("rethrows other database errors on create", async () => {
    store.user.create.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    await expect(githubSignIn({ id: "1001", email: "x@example.com" })).rejects.toThrow("db down");
  });

  it("does not touch the user table for a non-GitHub provider", async () => {
    const result = await authOptions.callbacks!.signIn!({
      user: { id: "x", email: "a@b.c" } as never,
      account: { provider: "credentials", type: "credentials", providerAccountId: "x" } as never,
    });
    expect(result).toBe(true);
    expect(store.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("GitHub sign-in email verification", () => {
  const UNVERIFIED = [{ email: "legacy@example.com", primary: true, verified: false }];
  const VERIFIED_LIST = [{ email: "legacy@example.com", primary: true, verified: true }];

  it("does not claim a legacy row by an unverified email and creates a placeholder account instead", async () => {
    const legacy = row({ id: "legacy", email: "legacy@example.com", githubPat: "gho_old" });
    const before = { ...legacy };

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      token: "gho_attacker",
      emails: UNVERIFIED,
    });

    expect(result).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before);
    expect(rows[1]).toMatchObject({ email: "github-1001@noreply", githubId: "1001", githubPat: "gho_attacker" });
    expect(user.id).toBe(rows[1].id);
    expect(store.user.updateMany).not.toHaveBeenCalled();
  });

  it("does not refuse on a password account's email when that email is unverified, it makes a placeholder account", async () => {
    const victim = row({ id: "v", email: "victim@example.com", passwordHash: "hash" });
    const before = { ...victim };

    const { result } = await githubSignIn({
      id: "1001",
      email: "victim@example.com",
      emails: [{ email: "victim@example.com", primary: true, verified: false }],
    });

    expect(result).toBe(true);
    expect(rows[0]).toEqual(before);
    expect(rows[1]).toMatchObject({ email: "github-1001@noreply", githubId: "1001" });
  });

  it("still refuses a password account when GitHub verifies that email", async () => {
    const victim = row({ id: "v", email: "victim@example.com", passwordHash: "hash" });
    const before = { ...victim };

    const { result } = await githubSignIn({ id: "1001", email: "victim@example.com" });

    expect(result).toBe(REFUSED);
    expect(rows).toEqual([before]);
  });

  it("claims a legacy row by a verified primary email (unchanged behaviour)", async () => {
    row({ id: "legacy", email: "legacy@example.com" });

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      emails: [{ email: "legacy@example.com", primary: true, verified: true }],
    });

    expect(result).toBe(true);
    expect(user.id).toBe("legacy");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ githubId: "1001", githubPat: "gho_new" });
  });

  it("creates the user under a verified primary email (unchanged behaviour)", async () => {
    const { result } = await githubSignIn({ id: "1001", email: "new@example.com" });

    expect(result).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "new@example.com", githubId: "1001" });
  });

  it("accepts a verified email that is not primary (verification is what proves ownership)", async () => {
    row({ id: "legacy", email: "legacy@example.com" });

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      emails: [
        { email: "main@example.com", primary: true, verified: true },
        { email: "legacy@example.com", primary: false, verified: true },
      ],
    });

    expect(result).toBe(true);
    expect(user.id).toBe("legacy");
    expect(rows[0].githubId).toBe("1001");
  });

  it("compares the verified email case-insensitively", async () => {
    row({ id: "legacy", email: "Legacy@Example.com" });

    const { result } = await githubSignIn({
      id: "1001",
      email: "Legacy@Example.com",
      emails: [{ email: "legacy@example.com", primary: true, verified: true }],
    });

    expect(result).toBe(true);
    expect(rows[0].githubId).toBe("1001");
  });

  it("does not trust an email that GitHub lists only as another address (not in /user/emails)", async () => {
    row({ id: "legacy", email: "legacy@example.com" });

    const { result } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      emails: [{ email: "other@example.com", primary: true, verified: true }],
    });

    expect(result).toBe(true);
    expect(rows[0].githubId).toBeNull();
    expect(rows[1]).toMatchObject({ email: "github-1001@noreply" });
  });

  it("requires verified to be exactly true", async () => {
    row({ id: "legacy", email: "legacy@example.com" });

    const { result } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      emails: [{ email: "legacy@example.com", primary: true, verified: "true" as never }],
    });

    expect(result).toBe(true);
    expect(rows[0].githubId).toBeNull();
  });

  it.each([
    ["a network error", "network-error"],
    ["a non-JSON answer", "not-json"],
    // Non-200 answers carry a body that would verify the email if the status
    // were ignored, so it is the status check that has to refuse.
    ["HTTP 401", { status: 401, body: VERIFIED_LIST }],
    ["HTTP 403", { status: 403, body: VERIFIED_LIST }],
    ["HTTP 500", { status: 500, body: VERIFIED_LIST }],
    ["HTTP 201", { status: 201, body: VERIFIED_LIST }],
    ["an empty list", { status: 200, body: [] }],
    ["a body that is not a list", { status: 200, body: { email: "legacy@example.com", verified: true } }],
  ] as const)("fails closed on %s: no claim, placeholder account, nothing sensitive logged", async (_name, emails) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacy = row({ id: "legacy", email: "legacy@example.com", githubPat: "gho_old" });
    const before = { ...legacy };

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      token: "gho_secret_token",
      emails: emails as EmailsAnswer,
    });

    expect(result).toBe(true);
    expect(rows[0]).toEqual(before);
    expect(rows[1]).toMatchObject({ email: "github-1001@noreply", githubId: "1001" });
    expect(user.id).toBe(rows[1].id);
    expect(store.user.updateMany).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("gho_secret_token");
  });

  it("treats the email as unverified when the sign-in carries no access token", async () => {
    row({ id: "legacy", email: "legacy@example.com" });

    const { result } = await githubSignIn({ id: "1001", email: "legacy@example.com", token: null });

    expect(result).toBe(true);
    expect(rows[0].githubId).toBeNull();
    expect(rows[1]).toMatchObject({ email: "github-1001@noreply", githubId: "1001" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches by identity without asking GitHub about the email", async () => {
    row({ id: "r1", email: "me@example.com", githubId: "1001", githubPat: "gho_old" });

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "me@example.com",
      token: "gho_fresh",
      emails: "network-error",
    });

    expect(result).toBe(true);
    expect(user.id).toBe("r1");
    expect(rows[0].githubPat).toBe("gho_fresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not ask GitHub when it reported no email (placeholder path)", async () => {
    const { result } = await githubSignIn({ id: "1001", email: null });

    expect(result).toBe(true);
    expect(rows[0].email).toBe("github-1001@noreply");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks GitHub for the email list with the account's token and nothing else on the URL", async () => {
    await githubSignIn({ id: "1001", email: "new@example.com", token: "gho_tok" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gho_tok");
  });

  it("does not use the unverified email's local part as the stored GitHub owner", async () => {
    await githubSignIn({
      id: "1001",
      email: "someone@example.com",
      emails: [{ email: "someone@example.com", primary: true, verified: false }],
    });

    expect(rows[0]).toMatchObject({ email: "github-1001@noreply", githubOwner: "github-1001" });
  });

  it("claims a legacy placeholder row after a failed lookup (the placeholder is derived from the verified GitHub id)", async () => {
    row({ id: "legacy", email: "github-1001@noreply" });

    const { result, user } = await githubSignIn({
      id: "1001",
      email: "legacy@example.com",
      emails: { status: 500 },
    });

    expect(result).toBe(true);
    expect(user.id).toBe("legacy");
    expect(rows[0].githubId).toBe("1001");
  });
});
