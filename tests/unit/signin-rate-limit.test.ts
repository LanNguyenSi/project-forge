import { beforeEach, describe, expect, it } from "vitest";
import {
  ADDRESS_MAX_FAILURES,
  EMAIL_MAX_FAILURES,
  MAX_TRACKED_KEYS,
  SIGNIN_WINDOW_MS,
  clientAddressFromHeaders,
  consumeSignInAttempt,
  normalizeEmailKey,
  releaseSignInAttempt,
  resetSignInLimiter,
  trackedKeyCounts,
} from "@/lib/signin-rate-limit";

beforeEach(() => resetSignInLimiter());

describe("normalizeEmailKey", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmailKey("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("bounds the key length", () => {
    expect(normalizeEmailKey("a".repeat(5000)).length).toBe(254);
  });
});

describe("clientAddressFromHeaders", () => {
  it("takes the right-most entry, never one the client could have written", () => {
    expect(clientAddressFromHeaders({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" })).toBe(
      "203.0.113.9",
    );
  });

  it("accepts a single entry, a repeated header (array) and IPv6, lower-cased", () => {
    expect(clientAddressFromHeaders({ "x-forwarded-for": "198.51.100.4" })).toBe("198.51.100.4");
    expect(clientAddressFromHeaders({ "x-forwarded-for": ["1.1.1.1", "198.51.100.5"] })).toBe(
      "198.51.100.5",
    );
    expect(clientAddressFromHeaders({ "x-forwarded-for": "2001:DB8::1" })).toBe("2001:db8::1");
  });

  it("returns null without a usable header or when the last entry is not an IP", () => {
    expect(clientAddressFromHeaders(undefined)).toBeNull();
    expect(clientAddressFromHeaders({})).toBeNull();
    expect(clientAddressFromHeaders({ "x-forwarded-for": "" })).toBeNull();
    expect(clientAddressFromHeaders({ "x-forwarded-for": "1.1.1.1, not-an-ip" })).toBeNull();
    expect(clientAddressFromHeaders({ "x-forwarded-for": 42 })).toBeNull();
  });

  it("does not read X-Real-IP", () => {
    expect(clientAddressFromHeaders({ "x-real-ip": "203.0.113.1" })).toBeNull();
  });
});

describe("consumeSignInAttempt", () => {
  it("allows EMAIL_MAX_FAILURES attempts per email, then refuses without counting", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) {
      expect(consumeSignInAttempt("a@x.com", null, 0)).toBe(true);
    }
    expect(consumeSignInAttempt("a@x.com", null, 0)).toBe(false);
    expect(consumeSignInAttempt("b@x.com", null, 0)).toBe(true);
  });

  it("allows ADDRESS_MAX_FAILURES attempts per address across emails, then refuses", () => {
    for (let i = 0; i < ADDRESS_MAX_FAILURES; i++) {
      expect(consumeSignInAttempt(`u${i}@x.com`, "203.0.113.9", 0)).toBe(true);
    }
    expect(consumeSignInAttempt("fresh@x.com", "203.0.113.9", 0)).toBe(false);
    expect(consumeSignInAttempt("fresh@x.com", "203.0.113.10", 0)).toBe(true);
    // No address: only the email limit applies.
    expect(consumeSignInAttempt("fresh2@x.com", null, 0)).toBe(true);
  });

  it("counts again from zero once the window has passed", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) consumeSignInAttempt("a@x.com", null, 0);
    expect(consumeSignInAttempt("a@x.com", null, SIGNIN_WINDOW_MS - 1)).toBe(false);
    expect(consumeSignInAttempt("a@x.com", null, SIGNIN_WINDOW_MS)).toBe(true);
    expect(trackedKeyCounts().emails).toBe(1);
  });

  it("a refused attempt does not extend the window", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) consumeSignInAttempt("a@x.com", null, 0);
    expect(consumeSignInAttempt("a@x.com", null, SIGNIN_WINDOW_MS - 1)).toBe(false);
    expect(consumeSignInAttempt("a@x.com", null, SIGNIN_WINDOW_MS)).toBe(true);
  });

  it("does not count the address when the email is already refused", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) consumeSignInAttempt("a@x.com", "203.0.113.9", 0);
    for (let i = 0; i < 100; i++) consumeSignInAttempt("a@x.com", "203.0.113.9", 0);
    // 10 counted attempts on the address, not 110.
    for (let i = 0; i < ADDRESS_MAX_FAILURES - EMAIL_MAX_FAILURES; i++) {
      expect(consumeSignInAttempt(`u${i}@x.com`, "203.0.113.9", 0)).toBe(true);
    }
    expect(consumeSignInAttempt("last@x.com", "203.0.113.9", 0)).toBe(false);
  });
});

describe("releaseSignInAttempt", () => {
  it("clears the email counter", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) consumeSignInAttempt("a@x.com", null, 0);
    releaseSignInAttempt("a@x.com", null, 0);
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) {
      expect(consumeSignInAttempt("a@x.com", null, 0)).toBe(true);
    }
    expect(consumeSignInAttempt("a@x.com", null, 0)).toBe(false);
  });

  it("gives back only its own attempt on the address counter", () => {
    for (let i = 0; i < ADDRESS_MAX_FAILURES - 1; i++) {
      consumeSignInAttempt(`u${i}@x.com`, "203.0.113.9", 0);
    }
    consumeSignInAttempt("mine@x.com", "203.0.113.9", 0); // 30th, allowed
    releaseSignInAttempt("mine@x.com", "203.0.113.9", 0); // back to 29
    expect(consumeSignInAttempt("one@x.com", "203.0.113.9", 0)).toBe(true); // 30th again
    expect(consumeSignInAttempt("two@x.com", "203.0.113.9", 0)).toBe(false);
  });

  it("drops an address entry that falls to zero and ignores an unknown or expired one", () => {
    consumeSignInAttempt("a@x.com", "203.0.113.9", 0);
    releaseSignInAttempt("a@x.com", "203.0.113.9", 0);
    expect(trackedKeyCounts()).toEqual({ emails: 0, addresses: 0 });
    releaseSignInAttempt("a@x.com", "203.0.113.9", 0);
    consumeSignInAttempt("b@x.com", "203.0.113.8", 0);
    releaseSignInAttempt("b@x.com", "203.0.113.8", SIGNIN_WINDOW_MS);
    expect(trackedKeyCounts().addresses).toBe(0);
  });
});

describe("bounded memory", () => {
  it("prunes expired entries when the map is full", () => {
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) consumeSignInAttempt(`old${i}@x.com`, null, 0);
    expect(trackedKeyCounts().emails).toBe(MAX_TRACKED_KEYS);
    consumeSignInAttempt("new@x.com", null, SIGNIN_WINDOW_MS);
    expect(trackedKeyCounts().emails).toBe(1);
  });

  it("never grows past the cap and evicts the oldest live entry", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) consumeSignInAttempt("first@x.com", null, 0);
    expect(consumeSignInAttempt("first@x.com", null, 0)).toBe(false);
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i++) consumeSignInAttempt(`k${i}@x.com`, null, 1);
    expect(trackedKeyCounts().emails).toBe(MAX_TRACKED_KEYS);
    // The oldest key ("first") was evicted: its counter is gone.
    expect(consumeSignInAttempt("first@x.com", null, 1)).toBe(true);
  });

  it("bounds the address map the same way", () => {
    for (let i = 0; i < MAX_TRACKED_KEYS + 20; i++) {
      consumeSignInAttempt("same@x.com", `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 0);
      resetEmail();
    }
    expect(trackedKeyCounts().addresses).toBe(MAX_TRACKED_KEYS);
  });
});

function resetEmail() {
  releaseSignInAttempt("same@x.com", null, 0);
}
