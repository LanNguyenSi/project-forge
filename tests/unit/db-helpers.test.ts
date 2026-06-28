import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit tests for the DB helper functions in lib/db.ts.
 * @prisma/client is mocked so no live DB is required.
 */

const mocks = vi.hoisted(() => ({
  apiToken: {
    findUnique: vi.fn(),
    update: vi.fn(),
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

import { validateApiToken, checkRateLimit, generateApiToken } from "@/lib/db";

describe("validateApiToken", () => {
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

  it("returns null when the DB record is not found (findUnique returns null)", async () => {
    mocks.apiToken.findUnique.mockResolvedValue(null);
    const result = await validateApiToken("pf_nonexistent");
    expect(result).toBeNull();
    expect(mocks.apiToken.update).not.toHaveBeenCalled();
  });

  it("returns null when record.revokedAt is a non-null Date", async () => {
    mocks.apiToken.findUnique.mockResolvedValue({
      id: "tok-1",
      token: "pf_revoked",
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
      token: "pf_valid",
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
      token: "pf_active",
      revokedAt: null,
      userId: "user-3",
      user: { id: "user-3", email: "a@b.com" },
    };
    mocks.apiToken.findUnique.mockResolvedValue(record);
    mocks.apiToken.update.mockResolvedValue(record);

    const result = await validateApiToken("pf_active");
    expect(result).toEqual(record);
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
