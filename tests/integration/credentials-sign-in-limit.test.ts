import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, compare } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));
vi.mock("bcryptjs", () => ({ default: { compare } }));

import { authOptions } from "@/lib/auth";
import {
  ADDRESS_MAX_FAILURES,
  EMAIL_MAX_FAILURES,
  SIGNIN_WINDOW_MS,
  resetSignInLimiter,
} from "@/lib/signin-rate-limit";

type Authorize = (
  credentials: Record<string, string> | undefined,
  req: { headers?: Record<string, unknown> },
) => Promise<{ id: string; email: string } | null>;

const provider = authOptions.providers.find(
  (p) => (p as { id: string }).id === "credentials",
) as unknown as { options: { authorize: Authorize } };
const authorize = provider.options.authorize;

const USERS: Record<string, { id: string; email: string; passwordHash: string | null }> = {
  "known@example.com": { id: "u1", email: "known@example.com", passwordHash: "hash" },
  "other@example.com": { id: "u2", email: "other@example.com", passwordHash: "hash" },
  "oauth@example.com": { id: "u3", email: "oauth@example.com", passwordHash: null },
  "victim@example.com": { id: "u4", email: "victim@example.com", passwordHash: "hash" },
  "VICTIM@example.com": { id: "u5", email: "VICTIM@example.com", passwordHash: "hash" },
};

const ADDR = "203.0.113.9";
const via = (address: string, spoofed = "6.6.6.6") => ({
  headers: { "x-forwarded-for": `${spoofed}, ${address}` },
});

function signIn(email: string, password: string, req: { headers?: Record<string, unknown> } = via(ADDR)) {
  return authorize({ email, password }, req);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  resetSignInLimiter();
  vi.clearAllMocks();
  findUnique.mockImplementation(async ({ where }: { where: { email: string } }) => {
    return USERS[where.email] ?? null;
  });
  compare.mockImplementation(async (password: string) => password === "right");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("credentials sign-in rate limit", () => {
  it("still signs in with the right password", async () => {
    expect(await signIn("known@example.com", "right")).toEqual({ id: "u1", email: "known@example.com" });
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("refuses attempt N+1 without a database read or a bcrypt run, even with the right password", async () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) {
      expect(await signIn("known@example.com", "wrong")).toBeNull();
    }
    expect(compare).toHaveBeenCalledTimes(EMAIL_MAX_FAILURES);
    expect(findUnique).toHaveBeenCalledTimes(EMAIL_MAX_FAILURES);

    expect(await signIn("known@example.com", "right")).toBeNull();
    expect(compare).toHaveBeenCalledTimes(EMAIL_MAX_FAILURES);
    expect(findUnique).toHaveBeenCalledTimes(EMAIL_MAX_FAILURES);
  });

  it("lets attempts through again once the window has passed", async () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) await signIn("known@example.com", "wrong");
    expect(await signIn("known@example.com", "right")).toBeNull();

    vi.advanceTimersByTime(SIGNIN_WINDOW_MS - 1);
    expect(await signIn("known@example.com", "right")).toBeNull();

    vi.advanceTimersByTime(1);
    expect(await signIn("known@example.com", "right")).toEqual({
      id: "u1",
      email: "known@example.com",
    });
  });

  it("a successful sign-in resets the email counter", async () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) await signIn("known@example.com", "wrong");
    expect(await signIn("known@example.com", "right")).not.toBeNull();

    // A fresh budget: another EMAIL_MAX_FAILURES - 1 failures, then success again.
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) {
      expect(await signIn("known@example.com", "wrong")).toBeNull();
    }
    expect(await signIn("known@example.com", "right")).not.toBeNull();
  });

  it("a successful sign-in does not reset the address counter", async () => {
    for (let i = 0; i < ADDRESS_MAX_FAILURES - 1; i++) {
      await signIn(`guess${i}@example.com`, "wrong");
    }
    // An attacker's own valid account: it signs in, but only gives back its own attempt.
    expect(await signIn("other@example.com", "right")).not.toBeNull();
    expect(await signIn("guess-a@example.com", "wrong")).toBeNull(); // 30th counted attempt
    compare.mockClear();
    findUnique.mockClear();

    expect(await signIn("known@example.com", "right")).toBeNull(); // refused: address used up
    expect(findUnique).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("limits per client address across different emails", async () => {
    for (let i = 0; i < ADDRESS_MAX_FAILURES; i++) {
      await signIn(`guess${i}@example.com`, "wrong");
    }
    findUnique.mockClear();
    compare.mockClear();

    // A different email, never tried before, from the same address.
    expect(await signIn("known@example.com", "right")).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();

    // The same email from another address is fine.
    expect(await signIn("known@example.com", "right", via("203.0.113.10"))).not.toBeNull();
  });

  it("counts unknown and OAuth-only emails like known ones, with the same refusal", async () => {
    const trace: Array<unknown> = [];
    for (const email of ["nobody@example.com", "known@example.com", "oauth@example.com"]) {
      resetSignInLimiter();
      const results: unknown[] = [];
      for (let i = 0; i < EMAIL_MAX_FAILURES + 2; i++) results.push(await signIn(email, "wrong"));
      findUnique.mockClear();
      results.push(await signIn(email, "right"));
      expect(findUnique).not.toHaveBeenCalled();
      trace.push(results);
    }
    // Every email produced the same sequence: all null, known or not.
    for (const results of trace as unknown[][]) {
      expect(results.every((r) => r === null)).toBe(true);
    }
  });

  it("keys the exact submitted string: case and space variants are separate counters", async () => {
    // Failures on variants of the address do not count against "known@example.com" ...
    for (let i = 0; i < EMAIL_MAX_FAILURES * 2; i++) {
      await signIn(i % 2 ? "KNOWN@Example.com" : " known@example.com ", "wrong", via(`198.51.100.${i}`));
    }
    findUnique.mockClear();
    expect(await signIn("known@example.com", "right", via("203.0.113.77"))).not.toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);

    // ... and the variants are limited on their own, each by its exact string.
    resetSignInLimiter();
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) {
      await signIn("KNOWN@Example.com", "wrong", via(`198.51.100.${i}`));
    }
    findUnique.mockClear();
    expect(await signIn("KNOWN@Example.com", "right", via("203.0.113.78"))).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("a success on a case variant account does not clear the victim's failure counter", async () => {
    // Two distinct accounts, as the exact-match lookup and the unique index see them.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) {
        await signIn("victim@example.com", "wrong", via(`198.51.100.${round * 20 + i}`));
      }
      // The attacker's own account signs in: it must not reset the victim's counter.
      expect(await signIn("VICTIM@example.com", "right", via("203.0.113.50"))).toEqual({
        id: "u5",
        email: "VICTIM@example.com",
      });
      compare.mockClear();
      findUnique.mockClear();
      // The victim's 10th attempt is still counted; the 11th is refused with no DB read or bcrypt.
      expect(await signIn("victim@example.com", "wrong", via("203.0.113.51"))).toBeNull();
      expect(compare).toHaveBeenCalledTimes(1);
      expect(await signIn("victim@example.com", "right", via("203.0.113.52"))).toBeNull();
      expect(compare).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledTimes(1);
      resetSignInLimiter();
    }
  });

  it("counts a burst of parallel attempts, not only the finished ones", async () => {
    const results = await Promise.all(
      Array.from({ length: EMAIL_MAX_FAILURES * 3 }, () => signIn("known@example.com", "wrong")),
    );
    expect(results.every((r) => r === null)).toBe(true);
    expect(compare).toHaveBeenCalledTimes(EMAIL_MAX_FAILURES);
  });

  it("a spoofed X-Forwarded-For prefix does not dodge the limits", async () => {
    for (let i = 0; i < ADDRESS_MAX_FAILURES; i++) {
      // A different forged left-hand entry on every request; the proxy-added last entry is constant.
      await signIn(`guess${i}@example.com`, "wrong", via(ADDR, `9.9.9.${i}`));
    }
    findUnique.mockClear();
    expect(await signIn("known@example.com", "right", via(ADDR, "1.2.3.4"))).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the email limit alone when there is no address", async () => {
    const noAddress = { headers: {} };
    // Far more failures across emails than the address limit: no address, no address limit.
    for (let i = 0; i < ADDRESS_MAX_FAILURES + 5; i++) {
      await signIn(`guess${i}@example.com`, "wrong", noAddress);
    }
    expect(await signIn("known@example.com", "right", noAddress)).not.toBeNull();

    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) await signIn("other@example.com", "wrong", noAddress);
    findUnique.mockClear();
    expect(await signIn("other@example.com", "right", noAddress)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    // And without a request object at all.
    expect(await authorize({ email: "other@example.com", password: "right" }, undefined as never)).toBeNull();
  });

  it("does not count a request without email or password", async () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES * 2; i++) {
      expect(await authorize({ email: "", password: "x" }, via(ADDR))).toBeNull();
      expect(await authorize({ email: "known@example.com", password: "" }, via(ADDR))).toBeNull();
      expect(await authorize(undefined, via(ADDR))).toBeNull();
    }
    expect(await signIn("known@example.com", "right")).not.toBeNull();
  });
});
