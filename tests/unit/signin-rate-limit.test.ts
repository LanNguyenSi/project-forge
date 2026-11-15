import { beforeEach, describe, expect, it } from "vitest";
import {
  ADDRESS_MAX_FAILURES,
  EMAIL_MAX_FAILURES,
  MAX_TRACKED_KEYS,
  SIGNIN_WINDOW_MS,
  clientAddressFromHeaders,
  consumeSignInAttempt,
  emailLimiterKey,
  releaseSignInAttempt,
  resetSignInLimiter,
  trackedKeyCounts,
} from "@/lib/signin-rate-limit";

beforeEach(() => resetSignInLimiter());

describe("emailLimiterKey", () => {
  it("keys the exact string: case and surrounding spaces make different keys", () => {
    const keys = new Set(
      ["victim@example.com", "VICTIM@example.com", " victim@example.com", "victim@example.com "].map(
        emailLimiterKey,
      ),
    );
    expect(keys.size).toBe(4);
    expect(emailLimiterKey("victim@example.com")).toBe(emailLimiterKey("victim@example.com"));
  });

  it("bounds the key size without letting long emails collide", () => {
    const long = "a".repeat(5000);
    expect(emailLimiterKey(long)).toHaveLength(64);
    expect(emailLimiterKey(long + "b")).not.toBe(emailLimiterKey(long + "c"));
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

  it("never grows past the cap, and a flood of single-attempt keys cannot evict a locked key", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) consumeSignInAttempt("first@x.com", null, 0);
    expect(consumeSignInAttempt("first@x.com", null, 0)).toBe(false);
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i++) consumeSignInAttempt(`k${i}@x.com`, null, 1);
    expect(trackedKeyCounts().emails).toBe(MAX_TRACKED_KEYS);
    expect(consumeSignInAttempt("first@x.com", null, 1)).toBe(false);
  });

  it("evicts the lowest count below the limit, so a key with failures outlives junk keys", () => {
    for (let i = 0; i < EMAIL_MAX_FAILURES - 1; i++) consumeSignInAttempt("victim@x.com", null, 0);
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i++) consumeSignInAttempt(`j${i}@x.com`, null, 1);
    expect(trackedKeyCounts().emails).toBe(MAX_TRACKED_KEYS);
    // Victim kept its 9 attempts: one more is allowed, then it is locked.
    expect(consumeSignInAttempt("victim@x.com", null, 1)).toBe(true);
    expect(consumeSignInAttempt("victim@x.com", null, 1)).toBe(false);
  });

  it("evicts the oldest among equal counts", () => {
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) consumeSignInAttempt(`e${i}@x.com`, null, 0);
    consumeSignInAttempt("e0@x.com", null, 0); // e0 now has 2, e1 is the oldest with 1
    consumeSignInAttempt("new@x.com", null, 0);
    for (let i = 0; i < EMAIL_MAX_FAILURES - 2; i++) consumeSignInAttempt("e0@x.com", null, 0);
    // e0 (count 2 then raised to 10) survived; e1 was evicted and starts over.
    expect(consumeSignInAttempt("e0@x.com", null, 0)).toBe(false);
    for (let i = 0; i < EMAIL_MAX_FAILURES; i++) {
      expect(consumeSignInAttempt("e1@x.com", null, 0)).toBe(true);
    }
  });

  it("does not track a new key when every entry is at its limit", () => {
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) {
      for (let j = 0; j < EMAIL_MAX_FAILURES; j++) consumeSignInAttempt(`l${i}@x.com`, null, 0);
    }
    expect(trackedKeyCounts().emails).toBe(MAX_TRACKED_KEYS);
    // The attempt is allowed but uncounted: never refused, nothing added.
    for (let i = 0; i < EMAIL_MAX_FAILURES * 3; i++) {
      expect(consumeSignInAttempt("new@x.com", null, 0)).toBe(true);
    }
    expect(trackedKeyCounts().emails).toBe(MAX_TRACKED_KEYS);
    expect(consumeSignInAttempt("l0@x.com", null, 0)).toBe(false);
    // Once the window ends the locked entries are pruned and tracking resumes.
    consumeSignInAttempt("new@x.com", null, SIGNIN_WINDOW_MS);
    expect(trackedKeyCounts().emails).toBe(1);
  });

  it("bounds the address map the same way", () => {
    for (let i = 0; i < MAX_TRACKED_KEYS + 20; i++) {
      consumeSignInAttempt("same@x.com", `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 0);
      resetEmail();
    }
    expect(trackedKeyCounts().addresses).toBe(MAX_TRACKED_KEYS);
    // A new address still gets tracked (a single-attempt entry made room) and limited.
    for (let i = 0; i < ADDRESS_MAX_FAILURES; i++) {
      expect(consumeSignInAttempt(`n${i}@x.com`, "9.9.9.9", 0)).toBe(true);
    }
    expect(consumeSignInAttempt("n-last@x.com", "9.9.9.9", 0)).toBe(false);
  });
});

function resetEmail() {
  releaseSignInAttempt("same@x.com", null, 0);
}
