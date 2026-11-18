import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import type { PrismaClient } from "@prisma/client";

/**
 * A claimed legacy row must not keep what it held before the claim. The row
 * (no githubId, no password) was made by an earlier GitHub-only sign-in, so its
 * API tokens and its sessions may belong to someone else than the verified
 * owner who claims it now, and the claim writes the owner's OAuth token into
 * it. Everything here runs against a real SQLite file built from the committed
 * migrations: the claim is the real signIn callback, API tokens are checked
 * through the real GET /api/v1/projects route, and sessions through the real
 * getServerSession (a signed session cookie) and the real GET /api/dashboard/pat
 * route.
 */

const SECRET = "test-secret-for-legacy-claim";
const ROOT = path.join(__dirname, "..", "..");
const COOKIE = "next-auth.session-token";

// The cookie of the request that the next getServerSession() call reads.
const current = vi.hoisted(() => ({
  cookie: null as string | null,
  // Runs after the session check passed and before the route goes on: the
  // window in which a claim can commit.
  afterSession: null as null | (() => Promise<void>),
}));

vi.mock("next-auth", async () => {
  const actual = await vi.importActual<typeof import("next-auth")>("next-auth");
  return {
    ...actual,
    // The route handlers call getServerSession(authOptions) and take the
    // cookie from the request scope; hand the real implementation the cookie
    // of the simulated request.
    getServerSession: async (options: import("next-auth").NextAuthOptions) => {
      const req = { cookies: current.cookie ? { [COOKIE]: current.cookie } : {}, headers: {} };
      const res = { setHeader() {}, getHeader() {} };
      const session = await (actual.getServerSession as (...a: unknown[]) => Promise<unknown>)(req, res, options);
      await current.afterSession?.();
      return session;
    },
  };
});

let tmpDir: string;
let db: PrismaClient;
let authOptions: typeof import("@/lib/auth").authOptions;
let createApiToken: typeof import("@/lib/db").createApiToken;
let validateApiToken: typeof import("@/lib/db").validateApiToken;
let projectsGET: typeof import("@/app/api/v1/projects/route").GET;
let patGET: typeof import("@/app/api/dashboard/pat/route").GET;
let patPOST: typeof import("@/app/api/dashboard/pat/route").POST;
let tokensPOST: typeof import("@/app/api/dashboard/tokens/route").POST;
let publishPOST: typeof import("@/app/api/publish/route").POST;
let nextAuthApi: typeof import("next-auth").default;
let decryptGithubPat: typeof import("@/lib/github-pat").decryptGithubPat;
let sessionOf: typeof import("next-auth").getServerSession;

const fetchMock = vi.fn();

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "pf-legacy-claim-"));
  const url = `file:${path.join(tmpDir, "claim.db")}`;
  execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  process.env.DATABASE_URL = url;
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.API_TOKEN_HASH_SECRET;
  delete process.env.NEXTAUTH_URL;
  // The modules read DATABASE_URL when they are first imported.
  ({ prisma: db } = await import("@/lib/db"));
  ({ createApiToken, validateApiToken } = await import("@/lib/db"));
  ({ authOptions } = await import("@/lib/auth"));
  ({ decryptGithubPat } = await import("@/lib/github-pat"));
  ({ GET: projectsGET } = await import("@/app/api/v1/projects/route"));
  ({ GET: patGET, POST: patPOST } = await import("@/app/api/dashboard/pat/route"));
  ({ POST: tokensPOST } = await import("@/app/api/dashboard/tokens/route"));
  ({ POST: publishPOST } = await import("@/app/api/publish/route"));
  nextAuthApi = (await import("next-auth")).default;
  ({ getServerSession: sessionOf } = await import("next-auth"));
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  current.cookie = null;
  current.afterSession = null;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  await db.usageLog.deleteMany();
  await db.apiToken.deleteMany();
  await db.user.deleteMany();
});

// GitHub lists `email` as primary and verified for the account.
function githubListsVerified(email: string) {
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify([{ email, primary: true, verified: true }]), { status: 200 }),
  );
}

async function githubSignIn(opts: { githubId: string; email: string; accessToken: string }) {
  githubListsVerified(opts.email);
  const user = { id: opts.githubId, email: opts.email };
  const result = await authOptions.callbacks!.signIn!({
    user: user as never,
    account: {
      provider: "github",
      type: "oauth",
      providerAccountId: opts.githubId,
      access_token: opts.accessToken,
    } as never,
    profile: { login: "owner" } as never,
  });
  return { result, user };
}

/** A signed session cookie for a JWT with these claims. */
async function cookieFor(claims: { userId: string; authAt?: number }): Promise<string> {
  return encode({ token: { ...claims }, secret: SECRET });
}

/** The JWT a sign-in mints now: the real jwt callback, then signed. */
async function mintSessionFor(userId: string): Promise<string> {
  const token = await authOptions.callbacks!.jwt!({
    token: {},
    user: { id: userId, email: "x@example.com" },
  } as never);
  return encode({ token, secret: SECRET });
}

async function tokenStatus(raw: string): Promise<number> {
  const res = await projectsGET(new NextRequest("http://localhost/api/v1/projects", { headers: { "X-API-Key": raw } }));
  return res.status;
}

async function patStatus(cookie: string | null): Promise<{ status: number; pat?: string }> {
  current.cookie = cookie;
  const res = await patGET();
  const body = (await res.json()) as { githubPat?: string };
  return { status: res.status, pat: body.githubPat };
}

/** Lets the clock move past the claim, so a token made now is later than the cutoff. */
const afterTheClaim = () => new Promise((r) => setTimeout(r, 5));

const LEGACY_EMAIL = "owner@example.com";
const OLD_AUTH_AT = () => Date.now() - 60_000;

async function seedLegacyRow() {
  const row = await db.user.create({ data: { email: LEGACY_EMAIL, githubPat: "gho_planted_by_old_holder" } });
  const first = await createApiToken(db, row.id, "first");
  const second = await createApiToken(db, row.id, "second");
  return { row, first, second };
}

describe("claiming a legacy row", () => {
  it("revokes every API token of the row, checked through the real route and verify function", async () => {
    const { row, first, second } = await seedLegacyRow();
    const alreadyRevoked = await createApiToken(db, row.id, "gone");
    const revokedAt = new Date("2026-01-02T03:04:05.000Z");
    await db.apiToken.update({ where: { id: alreadyRevoked.record.id }, data: { revokedAt } });
    const stranger = await db.user.create({ data: { email: "other@example.com", passwordHash: "hash" } });
    const strangerToken = await createApiToken(db, stranger.id, "stranger");

    // Before the claim both tokens work.
    expect(await tokenStatus(first.raw)).toBe(200);
    expect(await tokenStatus(second.raw)).toBe(200);

    const { result } = await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    expect(result).toBe(true);

    expect(await tokenStatus(first.raw)).toBe(401);
    expect(await tokenStatus(second.raw)).toBe(401);
    expect(await validateApiToken(first.raw)).toBeNull();
    expect(await validateApiToken(second.raw)).toBeNull();

    // A token that was revoked earlier keeps its original revocation time, and
    // another user's token is not touched.
    const kept = await db.apiToken.findUniqueOrThrow({ where: { id: alreadyRevoked.record.id } });
    expect(kept.revokedAt?.getTime()).toBe(revokedAt.getTime());
    expect(await tokenStatus(strangerToken.raw)).toBe(200);

    // The claim itself went through.
    const claimed = await db.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(claimed).toMatchObject({ githubId: "1001" });
    expect(claimed.githubPat).toMatch(/^v1:/);
    expect(decryptGithubPat(claimed.githubPat)).toBe("gho_owner");
    expect(claimed.sessionsValidAfter).toBeInstanceOf(Date);
  });

  it("a token issued to the owner after the claim works", async () => {
    const { row } = await seedLegacyRow();
    await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });

    await afterTheClaim();
    const fresh = await createApiToken(db, row.id, "after the claim");

    expect(await tokenStatus(fresh.raw)).toBe(200);
  });

  it("refuses a session minted before the claim, with and without a mint time, and accepts one minted after", async () => {
    const { row } = await seedLegacyRow();
    const oldCookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    const undatedCookie = await cookieFor({ userId: row.id });

    // Before the claim the old holder's session reads the token on the row.
    expect(await patStatus(oldCookie)).toEqual({ status: 200, pat: "gho_planted_by_old_holder" });
    expect(await patStatus(undatedCookie)).toEqual({ status: 200, pat: "gho_planted_by_old_holder" });

    const { result, user } = await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    expect(result).toBe(true);
    expect(user.id).toBe(row.id);

    expect(await patStatus(oldCookie)).toEqual({ status: 401, pat: undefined });
    expect(await patStatus(undatedCookie)).toEqual({ status: 401, pat: undefined });

    // The owner's own session, minted by the sign-in that claimed the row.
    expect(await patStatus(await mintSessionFor(user.id))).toEqual({ status: 200, pat: "gho_owner" });
  });

  it("compares the mint time with the cutoff inclusively", async () => {
    const { row } = await seedLegacyRow();
    const cutoff = new Date(Date.now() - 10_000);
    await db.user.update({ where: { id: row.id }, data: { sessionsValidAfter: cutoff } });

    expect((await patStatus(await cookieFor({ userId: row.id, authAt: cutoff.getTime() - 1 }))).status).toBe(401);
    expect((await patStatus(await cookieFor({ userId: row.id, authAt: cutoff.getTime() }))).status).toBe(200);
    expect((await patStatus(await cookieFor({ userId: row.id, authAt: cutoff.getTime() + 1 }))).status).toBe(200);
  });

  it("revokes nothing and keeps the row as it was when the transaction fails", async () => {
    const { row, first, second } = await seedLegacyRow();
    const oldCookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    // The token revoke fails inside the transaction, after the claim write.
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fail_token_revoke BEFORE UPDATE ON "ApiToken" BEGIN SELECT RAISE(ABORT, 'revoke failed'); END`,
    );
    try {
      await expect(
        githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" }),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER fail_token_revoke`);
    }

    const after = await db.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ githubId: null, githubPat: "gho_planted_by_old_holder", sessionsValidAfter: null });
    expect(await tokenStatus(first.raw)).toBe(200);
    expect(await tokenStatus(second.raw)).toBe(200);
    expect(await patStatus(oldCookie)).toEqual({ status: 200, pat: "gho_planted_by_old_holder" });
  });
});

describe("sign-ins that are not a claim of a legacy row", () => {
  it("a row that already has this githubId keeps its tokens and its sessions", async () => {
    const row = await db.user.create({ data: { email: LEGACY_EMAIL, githubId: "1001", githubPat: "gho_old" } });
    const token = await createApiToken(db, row.id, "mine");
    const cookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });

    const { result } = await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_fresh" });

    expect(result).toBe(true);
    expect(await tokenStatus(token.raw)).toBe(200);
    expect(await patStatus(cookie)).toEqual({ status: 200, pat: "gho_fresh" });
    expect((await db.user.findUniqueOrThrow({ where: { id: row.id } })).sessionsValidAfter).toBeNull();
  });

  it("a refused sign-in on a password account keeps its tokens and its sessions", async () => {
    const row = await db.user.create({ data: { email: LEGACY_EMAIL, passwordHash: "hash", githubPat: "ghp_manual" } });
    const token = await createApiToken(db, row.id, "mine");
    const cookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });

    const { result } = await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_other" });

    expect(result).toBe("/login?error=OAuthAccountNotLinked");
    expect(await tokenStatus(token.raw)).toBe(200);
    expect(await patStatus(cookie)).toEqual({ status: 200, pat: "ghp_manual" });
    expect((await db.user.findUniqueOrThrow({ where: { id: row.id } })).sessionsValidAfter).toBeNull();
  });

  it("a new GitHub account does not touch another user's tokens", async () => {
    const other = await db.user.create({ data: { email: "other@example.com", passwordHash: "hash" } });
    const token = await createApiToken(db, other.id, "other");

    const { result } = await githubSignIn({ githubId: "1001", email: "brand-new@example.com", accessToken: "gho_new" });

    expect(result).toBe(true);
    expect(await tokenStatus(token.raw)).toBe(200);
    const created = await db.user.findUniqueOrThrow({ where: { email: "brand-new@example.com" } });
    expect(created.sessionsValidAfter).toBeNull();
  });

  it("a session without a mint time stays valid while the user has no cutoff", async () => {
    const row = await db.user.create({ data: { email: "plain@example.com", passwordHash: "hash", githubPat: "ghp_x" } });

    expect(await patStatus(await cookieFor({ userId: row.id }))).toEqual({ status: 200, pat: "ghp_x" });
  });
});

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("what getServerSession and /api/auth/session say about a session below the cutoff", () => {
  it("getServerSession returns null, and the session endpoint returns an empty body; a session at the cutoff is served", async () => {
    const { row } = await seedLegacyRow();
    const oldCookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    const fresh = await mintSessionFor(row.id);

    // GET /api/auth/session as the browser calls it (the pages-style handler,
    // because the route-handler form reads cookies() from the request scope).
    const sessionBody = async (cookie: string) => {
      let body: unknown;
      const res = {
        status: () => res,
        setHeader: () => res,
        getHeader: () => undefined,
        end: () => res,
        json: () => res,
        send: (b: unknown) => {
          body = b;
          return res;
        },
      };
      await (nextAuthApi as unknown as (...a: unknown[]) => Promise<void>)(
        { query: { nextauth: ["session"] }, method: "GET", cookies: { [COOKIE]: cookie }, headers: {}, body: {} },
        res,
        { ...authOptions, secret: SECRET },
      );
      return body as Record<string, unknown> & { user?: { id?: string } };
    };

    current.cookie = oldCookie;
    expect(await sessionOf(authOptions)).toBeNull();
    expect(await sessionBody(oldCookie)).toEqual({});

    current.cookie = fresh;
    expect(await sessionOf(authOptions)).toMatchObject({ user: { id: row.id } });
    expect((await sessionBody(fresh)).user?.id).toBe(row.id);
  });
});

describe("a claim that commits after the session check passed", () => {
  const claimBetween = () => {
    current.afterSession = async () => {
      current.afterSession = null;
      const { result } = await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
      expect(result).toBe(true);
    };
  };

  it("GET /api/dashboard/pat does not hand the new owner's token to the older session", async () => {
    const { row } = await seedLegacyRow();
    const oldCookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    current.cookie = oldCookie;
    claimBetween();

    const res = await patGET();

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("gho_owner");
    expect(decryptGithubPat((await db.user.findUniqueOrThrow({ where: { id: row.id } })).githubPat)).toBe("gho_owner");
  });

  it("GET /api/dashboard/pat still answers a session minted at or after the claim", async () => {
    const { row } = await seedLegacyRow();
    await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });

    expect(await patStatus(await mintSessionFor(row.id))).toEqual({ status: 200, pat: "gho_owner" });
  });

  it("POST /api/dashboard/pat does not overwrite the new owner's token from the older session", async () => {
    const { row } = await seedLegacyRow();
    current.cookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    claimBetween();

    const res = await patPOST(jsonReq("http://localhost/api/dashboard/pat", { githubPat: "ghp_from_old_session" }));

    expect(res.status).toBe(401);
    expect(decryptGithubPat((await db.user.findUniqueOrThrow({ where: { id: row.id } })).githubPat)).toBe("gho_owner");
  });

  it("POST /api/dashboard/pat saves for a session minted after the claim, and for a user with no cutoff", async () => {
    const { row } = await seedLegacyRow();
    await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    current.cookie = await mintSessionFor(row.id);
    expect((await patPOST(jsonReq("http://localhost/api/dashboard/pat", { githubPat: "ghp_after_claim" }))).status).toBe(200);
    expect(decryptGithubPat((await db.user.findUniqueOrThrow({ where: { id: row.id } })).githubPat)).toBe("ghp_after_claim");

    const plain = await db.user.create({ data: { email: "plain@example.com", passwordHash: "hash" } });
    current.cookie = await cookieFor({ userId: plain.id });
    expect((await patPOST(jsonReq("http://localhost/api/dashboard/pat", { githubPat: "ghp_plain" }))).status).toBe(200);
    expect(decryptGithubPat((await db.user.findUniqueOrThrow({ where: { id: plain.id } })).githubPat)).toBe("ghp_plain");
  });

  it("POST /api/dashboard/pat saves for a session minted in the same millisecond as the cutoff", async () => {
    const { row } = await seedLegacyRow();
    const cutoff = new Date(Date.now() - 5_000);
    await db.user.update({ where: { id: row.id }, data: { sessionsValidAfter: cutoff } });
    current.cookie = await cookieFor({ userId: row.id, authAt: cutoff.getTime() });

    expect((await patPOST(jsonReq("http://localhost/api/dashboard/pat", { githubPat: "ghp_same_ms" }))).status).toBe(200);
    expect(decryptGithubPat((await db.user.findUniqueOrThrow({ where: { id: row.id } })).githubPat)).toBe("ghp_same_ms");
  });

  it("POST /api/dashboard/tokens gives the older session no usable token, and revokes the one it created", async () => {
    const { row } = await seedLegacyRow();
    current.cookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    claimBetween();

    const res = await tokensPOST(jsonReq("http://localhost/api/dashboard/tokens", { name: "from old session" }));

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("pf_");
    const made = await db.apiToken.findMany({ where: { userId: row.id, name: "from old session" } });
    expect(made).toHaveLength(1);
    expect(made[0].revokedAt).toBeInstanceOf(Date);
    expect(await db.apiToken.count({ where: { userId: row.id, revokedAt: null } })).toBe(0);
  });

  it("POST /api/dashboard/tokens issues a working token to a session minted after the claim and to a user with no cutoff", async () => {
    const { row } = await seedLegacyRow();
    await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    await afterTheClaim();
    current.cookie = await mintSessionFor(row.id);
    const res = await tokensPOST(jsonReq("http://localhost/api/dashboard/tokens", { name: "after claim" }));
    expect(res.status).toBe(200);
    expect(await tokenStatus(((await res.json()) as { token: { token: string } }).token.token)).toBe(200);

    const plain = await db.user.create({ data: { email: "plain@example.com", passwordHash: "hash" } });
    current.cookie = await cookieFor({ userId: plain.id });
    const res2 = await tokensPOST(jsonReq("http://localhost/api/dashboard/tokens", { name: "plain" }));
    expect(res2.status).toBe(200);
    expect(await tokenStatus(((await res2.json()) as { token: { token: string } }).token.token)).toBe(200);
  });

  it("POST /api/publish refuses the older session before it uses the new owner's token", async () => {
    const { row } = await seedLegacyRow();
    current.cookie = await cookieFor({ userId: row.id, authAt: OLD_AUTH_AT() });
    claimBetween();

    const res = await publishPOST(
      jsonReq("http://localhost/api/publish", {
        sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        projectName: "p",
      }),
    );

    expect(res.status).toBe(401);
    // Only the claim's own email lookup went out, nothing was sent to GitHub with the token.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.endsWith("/user/emails"))).toBe(true);
  });
});

describe("a claim that commits between the two reads of validateApiToken", () => {
  /** Runs the claim right before the first read of a user row by id (validateApiToken's), once. */
  function claimBeforeUserRead() {
    const real = db.user.findUnique.bind(db.user) as (args: unknown) => Promise<unknown>;
    const spy = vi.spyOn(db.user, "findUnique").mockImplementation(((args: { where: Record<string, unknown> }) => {
      if (args.where.id === undefined) return real(args);
      spy.mockImplementation(real as never);
      return githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" }).then(() => real(args));
    }) as never);
    return spy;
  }

  afterEach(() => vi.restoreAllMocks());

  it("validateApiToken refuses a token the claim has just revoked, instead of returning it with the new owner's token", async () => {
    const { first } = await seedLegacyRow();
    const spy = claimBeforeUserRead();

    expect(await validateApiToken(first.raw)).toBeNull();

    expect(spy).toHaveBeenCalled();
    expect(decryptGithubPat((await db.user.findFirstOrThrow({ where: { email: LEGACY_EMAIL } })).githubPat)).toBe("gho_owner");
  });

  it("GET /api/v1/projects answers 401 for it", async () => {
    const { first } = await seedLegacyRow();
    claimBeforeUserRead();

    expect(await tokenStatus(first.raw)).toBe(401);
  });

  it("a token created after the claim started but before it took the write lock is refused when read across the commit", async () => {
    // Pins where the claim takes its cutoff: after its first write holds the
    // lock. Taken before the transaction, this token's createdAt would lie
    // above the cutoff and it would be served with the new owner's token.
    const { row } = await seedLegacyRow();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let entered!: () => void;
    const claimReachedTransaction = new Promise<void>((resolve) => (entered = resolve));
    const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(db, "$transaction").mockImplementation((async (...args: unknown[]) => {
      entered();
      await gate;
      return realTransaction(...args);
    }) as never);
    const claimDone = githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    await claimReachedTransaction;
    await new Promise((resolve) => setTimeout(resolve, 3));
    const late = await createApiToken(db, row.id, "late");
    await new Promise((resolve) => setTimeout(resolve, 3));
    const realFind = db.user.findUnique.bind(db.user) as (args: unknown) => Promise<unknown>;
    const spy = vi.spyOn(db.user, "findUnique").mockImplementation(((args: { where: Record<string, unknown> }) => {
      if (args.where.id === undefined) return realFind(args);
      spy.mockImplementation(realFind as never);
      openGate();
      return claimDone.then(() => realFind(args));
    }) as never);

    const record = await validateApiToken(late.raw);

    expect(spy).toHaveBeenCalled();
    expect(record).toBeNull();
    expect(decryptGithubPat((await db.user.findFirstOrThrow({ where: { email: LEGACY_EMAIL } })).githubPat)).toBe("gho_owner");
  });

  it("a token the owner creates after the claim is served", async () => {
    const { row } = await seedLegacyRow();
    await githubSignIn({ githubId: "1001", email: LEGACY_EMAIL, accessToken: "gho_owner" });
    await afterTheClaim();
    const fresh = await createApiToken(db, row.id, "after");

    const record = await validateApiToken(fresh.raw);

    expect(decryptGithubPat(record?.user.githubPat)).toBe("gho_owner");
  });
});
