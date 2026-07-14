import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

/**
 * Unit tests for the DB helper functions in lib/db.ts.
 * @prisma/client is mocked so no live DB is required.
 */

const mocks = vi.hoisted(() => ({
  apiToken: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  usageLog: {
    count: vi.fn(),
  },
}));

vi.mock("@prisma/client", () => ({
  // Regular function (not arrow) so it can be called with `new`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PrismaClient: vi.fn(function MockPrismaClient(this: any) {
    this.apiToken = mocks.apiToken;
    this.usageLog = mocks.usageLog;
  }),
}));

import {
  validateApiToken,
  checkRateLimit,
  generateApiToken,
  hashApiToken,
  tokenPrefixOf,
  createApiToken,
} from "@/lib/db";

describe("validateApiToken", () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-hash-secret";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null immediately for tokens that do not start with 'pf_'", async () => {
    const result = await validateApiToken("sk_not_a_pf_token");
    expect(result).toBeNull();
    expect(mocks.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for an empty string (prefix guard)", async () => {
    const result = await validateApiToken("");
    expect(result).toBeNull();
    expect(mocks.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("looks up by the HMAC hash of the presented token, never the raw value", async () => {
    mocks.apiToken.findUnique.mockResolvedValue(null);
    await validateApiToken("pf_nonexistent");

    expect(mocks.apiToken.findUnique).toHaveBeenCalledTimes(1);
    const findArg = mocks.apiToken.findUnique.mock.calls[0][0];
    expect(findArg.where.tokenHash).toBe(hashApiToken("pf_nonexistent"));
    expect(findArg.where.tokenHash).not.toBe("pf_nonexistent");
  });

  it("returns null when the DB record is not found (findUnique returns null)", async () => {
    mocks.apiToken.findUnique.mockResolvedValue(null);
    const result = await validateApiToken("pf_nonexistent");
    expect(result).toBeNull();
    expect(mocks.apiToken.update).not.toHaveBeenCalled();
  });

  it("returns null when record.revokedAt is a non-null Date", async () => {
    mocks.apiToken.findUnique.mockResolvedValue({
      id: "tok-1",
      tokenHash: hashApiToken("pf_revoked"),
      revokedAt: new Date("2024-01-01T00:00:00Z"),
      user: { id: "user-1" },
    });
    const result = await validateApiToken("pf_revoked");
    expect(result).toBeNull();
    expect(mocks.apiToken.update).not.toHaveBeenCalled();
  });

  it("calls apiToken.update with lastUsedAt when token is valid", async () => {
    const record = {
      id: "tok-2",
      tokenHash: hashApiToken("pf_valid"),
      revokedAt: null,
      user: { id: "user-2", email: "u@test.com" },
    };
    mocks.apiToken.findUnique.mockResolvedValue(record);
    mocks.apiToken.update.mockResolvedValue({ ...record, lastUsedAt: new Date() });

    await validateApiToken("pf_valid");

    expect(mocks.apiToken.update).toHaveBeenCalledTimes(1);
    const updateArg = mocks.apiToken.update.mock.calls[0][0];
    expect(updateArg.where.id).toBe("tok-2");
    expect(updateArg.data.lastUsedAt).toBeInstanceOf(Date);
  });

  it("returns the full token record on a valid (non-revoked) token", async () => {
    const record = {
      id: "tok-3",
      tokenHash: hashApiToken("pf_active"),
      revokedAt: null,
      userId: "user-3",
      user: { id: "user-3", email: "a@b.com" },
    };
    mocks.apiToken.findUnique.mockResolvedValue(record);
    mocks.apiToken.update.mockResolvedValue(record);

    const result = await validateApiToken("pf_active");
    expect(result).toEqual(record);
  });

  it("rejects a wrong/invalid token even when a differently-keyed record exists", async () => {
    // Simulate the DB only holding the hash for a *different* raw token —
    // findUnique correctly returns null because the hashes don't match.
    mocks.apiToken.findUnique.mockImplementation(({ where }) =>
      where.tokenHash === hashApiToken("pf_correct_value")
        ? Promise.resolve({ id: "tok-4", revokedAt: null, user: { id: "user-4" } })
        : Promise.resolve(null)
    );

    const validResult = await validateApiToken("pf_correct_value");
    const invalidResult = await validateApiToken("pf_wrong_guess");

    expect(validResult).not.toBeNull();
    expect(invalidResult).toBeNull();
  });
});

describe("hashApiToken / tokenPrefixOf", () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-hash-secret";
  });

  it("is deterministic: the same raw token always hashes to the same value", () => {
    expect(hashApiToken("pf_sample")).toBe(hashApiToken("pf_sample"));
  });

  it("produces different hashes for different raw tokens", () => {
    expect(hashApiToken("pf_one")).not.toBe(hashApiToken("pf_two"));
  });

  it("produces a 64-char hex digest (SHA-256)", () => {
    expect(hashApiToken("pf_sample")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is keyed: the same raw token hashes differently under a different secret", () => {
    const a = hashApiToken("pf_sample");
    process.env.NEXTAUTH_SECRET = "a-different-secret";
    const b = hashApiToken("pf_sample");
    process.env.NEXTAUTH_SECRET = "test-hash-secret";
    expect(a).not.toBe(b);
  });

  it("throws when no hash secret is configured", () => {
    const original = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.API_TOKEN_HASH_SECRET;
    try {
      expect(() => hashApiToken("pf_sample")).toThrow(/API_TOKEN_HASH_SECRET/);
    } finally {
      process.env.NEXTAUTH_SECRET = original;
    }
  });

  it("prefers API_TOKEN_HASH_SECRET over NEXTAUTH_SECRET when both are set", () => {
    process.env.API_TOKEN_HASH_SECRET = "dedicated-secret";
    const withDedicated = hashApiToken("pf_sample");
    delete process.env.API_TOKEN_HASH_SECRET;
    const withFallback = hashApiToken("pf_sample");
    expect(withDedicated).not.toBe(withFallback);
  });

  it("tokenPrefixOf returns the first 10 characters of the raw token", () => {
    expect(tokenPrefixOf("pf_abcdefghijklmnop")).toBe("pf_abcdefg");
  });
});

describe("createApiToken", () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-hash-secret";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists only the hash + prefix, never the raw token", async () => {
    mocks.apiToken.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: "tok-new", ...data })
    );

    const { raw, record } = await createApiToken({ apiToken: mocks.apiToken }, "user-1", "ci");

    expect(raw).toMatch(/^pf_/);
    expect(mocks.apiToken.create).toHaveBeenCalledTimes(1);
    const createArg = mocks.apiToken.create.mock.calls[0][0];
    expect(createArg.data).not.toHaveProperty("token");
    expect(createArg.data.tokenHash).toBe(hashApiToken(raw));
    expect(createArg.data.tokenPrefix).toBe(tokenPrefixOf(raw));
    expect(createArg.data.userId).toBe("user-1");
    expect(createArg.data.name).toBe("ci");
    expect(record.tokenHash).toBe(hashApiToken(raw));
    // The raw value must never appear anywhere in what got persisted.
    expect(JSON.stringify(createArg)).not.toContain(raw);
  });

  it("the returned raw token round-trips through validateApiToken's hash lookup", async () => {
    mocks.apiToken.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: "tok-rt", revokedAt: null, user: { id: "user-1" }, ...data })
    );

    const { raw } = await createApiToken({ apiToken: mocks.apiToken }, "user-1", "ci");

    mocks.apiToken.findUnique.mockImplementation(({ where }) =>
      where.tokenHash === hashApiToken(raw)
        ? Promise.resolve({ id: "tok-rt", revokedAt: null, user: { id: "user-1" } })
        : Promise.resolve(null)
    );
    mocks.apiToken.update.mockResolvedValue({});

    const validated = await validateApiToken(raw);
    expect(validated).not.toBeNull();
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allowed:true when usage count is 9 (one below limit)", async () => {
    mocks.usageLog.count.mockResolvedValue(9);
    const result = await checkRateLimit("user-1");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(9);
  });

  it("allowed:false when usage count is exactly 10 (at limit)", async () => {
    mocks.usageLog.count.mockResolvedValue(10);
    const result = await checkRateLimit("user-1");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(10);
  });

  it("allowed:false when usage count exceeds 10", async () => {
    mocks.usageLog.count.mockResolvedValue(15);
    const result = await checkRateLimit("user-1");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(15);
  });

  it("allowed:true when usage count is 0 (first use)", async () => {
    mocks.usageLog.count.mockResolvedValue(0);
    const result = await checkRateLimit("user-1");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });
});

describe("generateApiToken", () => {
  it("produces a token matching the pf_ prefix + 32 base64url chars format", () => {
    const token = generateApiToken();
    // 24 bytes → 32 base64url chars
    expect(token).toMatch(/^pf_[A-Za-z0-9_-]{32}$/);
  });

  it("produces a unique token on every call", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateApiToken()));
    expect(tokens.size).toBe(20);
  });
});
