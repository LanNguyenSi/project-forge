import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TRACKED_REGISTER_KEYS,
  NO_ADDRESS_KEY,
  REGISTER_MAX_ATTEMPTS,
  REGISTER_WINDOW_MS,
  resetRegisterLimiter,
  takeRegisterAttempt,
  trackedRegisterKeyCount,
} from "@/lib/register-rate-limit";

beforeEach(() => resetRegisterLimiter());

describe("literal limits", () => {
  it("pins 5 attempts per hour", () => {
    expect(REGISTER_MAX_ATTEMPTS).toBe(5);
    expect(REGISTER_WINDOW_MS).toBe(3_600_000);
  });
});

describe("takeRegisterAttempt per address", () => {
  it("allows REGISTER_MAX_ATTEMPTS attempts per address, then refuses without counting", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect(takeRegisterAttempt("203.0.113.9", 0)).toBe(true);
    }
    expect(takeRegisterAttempt("203.0.113.9", 0)).toBe(false);
    expect(trackedRegisterKeyCount()).toBe(1);
  });

  it("another address is unaffected by a used-up one", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) takeRegisterAttempt("203.0.113.9", 0);
    expect(takeRegisterAttempt("203.0.113.10", 0)).toBe(true);
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS - 1; i++) takeRegisterAttempt("203.0.113.10", 0);
    expect(takeRegisterAttempt("203.0.113.10", 0)).toBe(false);
  });

  it("counts every attempt, successes included: nothing is ever handed back", () => {
    // The module exposes no release; the cap is reached by plain attempts.
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect(takeRegisterAttempt("203.0.113.9", 0)).toBe(true);
    }
    expect(takeRegisterAttempt("203.0.113.9", 0)).toBe(false);
    expect(takeRegisterAttempt("203.0.113.9", 1)).toBe(false);
  });

  it("counts again from zero once the window has passed", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) takeRegisterAttempt("203.0.113.9", 0);
    expect(takeRegisterAttempt("203.0.113.9", REGISTER_WINDOW_MS - 1)).toBe(false);
    expect(takeRegisterAttempt("203.0.113.9", REGISTER_WINDOW_MS)).toBe(true);
    expect(trackedRegisterKeyCount()).toBe(1);
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS - 1; i++) {
      expect(takeRegisterAttempt("203.0.113.9", REGISTER_WINDOW_MS)).toBe(true);
    }
    expect(takeRegisterAttempt("203.0.113.9", REGISTER_WINDOW_MS)).toBe(false);
  });

  it("a refused attempt does not extend the window", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) takeRegisterAttempt("203.0.113.9", 0);
    expect(takeRegisterAttempt("203.0.113.9", REGISTER_WINDOW_MS - 1)).toBe(false);
    expect(takeRegisterAttempt("203.0.113.9", REGISTER_WINDOW_MS)).toBe(true);
  });
});

describe("fallback key for requests without a usable address", () => {
  it("null addresses share one key with the same cap, whatever the time of each attempt", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect(takeRegisterAttempt(null, i)).toBe(true);
    }
    expect(takeRegisterAttempt(null, REGISTER_MAX_ATTEMPTS)).toBe(false);
    // One counter for all of them, not one per request.
    expect(trackedRegisterKeyCount()).toBe(1);
  });

  it("the fallback key is separate from real addresses, both ways", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) takeRegisterAttempt(null, 0);
    expect(takeRegisterAttempt("203.0.113.9", 0)).toBe(true); // address unaffected
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) takeRegisterAttempt("198.51.100.7", 0);
    expect(takeRegisterAttempt(null, 0)).toBe(false); // fallback stays used up
  });

  it("the fallback key never collides with a real address", () => {
    expect(NO_ADDRESS_KEY).not.toMatch(/^\d|^([0-9a-f]{0,4}:)+[0-9a-f]{0,4}$/i);
  });
});

describe("bounded memory", () => {
  it("prunes expired entries when the map is full", () => {
    for (let i = 0; i < MAX_TRACKED_REGISTER_KEYS; i++) takeRegisterAttempt(addr(i), 0);
    expect(trackedRegisterKeyCount()).toBe(MAX_TRACKED_REGISTER_KEYS);
    takeRegisterAttempt("9.9.9.9", REGISTER_WINDOW_MS);
    expect(trackedRegisterKeyCount()).toBe(1);
  });

  it("never grows past the cap, and a flood of single-attempt keys cannot evict a used-up key", () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) takeRegisterAttempt("8.8.8.8", 0);
    expect(takeRegisterAttempt("8.8.8.8", 0)).toBe(false);
    for (let i = 0; i < MAX_TRACKED_REGISTER_KEYS + 50; i++) takeRegisterAttempt(addr(i), 1);
    expect(trackedRegisterKeyCount()).toBe(MAX_TRACKED_REGISTER_KEYS);
    expect(takeRegisterAttempt("8.8.8.8", 1)).toBe(false);
  });

  it("evicts the lowest count below the limit, oldest first on a tie", () => {
    for (let i = 0; i < MAX_TRACKED_REGISTER_KEYS; i++) takeRegisterAttempt(addr(i), 0);
    takeRegisterAttempt(addr(0), 0); // addr(0) now has 2, addr(1) is the oldest with 1
    takeRegisterAttempt("9.9.9.9", 0);
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS - 2; i++) takeRegisterAttempt(addr(0), 0);
    // addr(0) (count 2, then raised to the limit) survived; addr(1) was evicted and starts over.
    expect(takeRegisterAttempt(addr(0), 0)).toBe(false);
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect(takeRegisterAttempt(addr(1), 0)).toBe(true);
    }
    expect(takeRegisterAttempt(addr(1), 0)).toBe(false);
  });

  it("does not track a new key when every entry is at its limit", () => {
    for (let i = 0; i < MAX_TRACKED_REGISTER_KEYS; i++) {
      for (let j = 0; j < REGISTER_MAX_ATTEMPTS; j++) takeRegisterAttempt(addr(i), 0);
    }
    expect(trackedRegisterKeyCount()).toBe(MAX_TRACKED_REGISTER_KEYS);
    // The attempt is allowed but uncounted: never refused, nothing added.
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS * 3; i++) {
      expect(takeRegisterAttempt("9.9.9.9", 0)).toBe(true);
    }
    expect(trackedRegisterKeyCount()).toBe(MAX_TRACKED_REGISTER_KEYS);
    expect(takeRegisterAttempt(addr(0), 0)).toBe(false);
    // Once the window ends the used-up entries are pruned and tracking resumes.
    takeRegisterAttempt("9.9.9.9", REGISTER_WINDOW_MS);
    expect(trackedRegisterKeyCount()).toBe(1);
  });
});

function addr(i: number): string {
  return `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
}
