import { describe, expect, it } from "vitest";
import { validateProjectName, SESSION_UUID_RE, SESSION_TTL_MS, isSessionExpired } from "@/lib/v1-shared";
import type { ForgeMeta } from "@/lib/v1-shared";

describe("validateProjectName", () => {
  it("accepts a simple lowercase name", () => {
    expect(validateProjectName("my-project")).toBe(true);
  });

  it("accepts letters, digits, dots, hyphens, and underscores", () => {
    expect(validateProjectName("MyApp_v2.0-beta")).toBe(true);
  });

  it("accepts a single character", () => {
    expect(validateProjectName("a")).toBe(true);
  });

  it("accepts exactly 100 characters (boundary)", () => {
    expect(validateProjectName("a".repeat(100))).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateProjectName("")).toBe(false);
  });

  it("rejects a string with a space", () => {
    expect(validateProjectName("my project")).toBe(false);
  });

  it("rejects a forward slash (path separator)", () => {
    expect(validateProjectName("my/project")).toBe(false);
  });

  it("rejects a backslash", () => {
    expect(validateProjectName("my\\project")).toBe(false);
  });

  it("rejects 101 characters (over limit)", () => {
    expect(validateProjectName("a".repeat(101))).toBe(false);
  });

  it("rejects a dot-dot traversal attempt", () => {
    expect(validateProjectName("../../etc")).toBe(false);
  });

  it("rejects a name with special shell characters", () => {
    expect(validateProjectName("foo;bar")).toBe(false);
  });

  it("rejects null bytes", () => {
    expect(validateProjectName("foo\0bar")).toBe(false);
  });
});

describe("SESSION_UUID_RE", () => {
  it("accepts a well-formed lowercase UUID v4", () => {
    expect(SESSION_UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts a well-formed uppercase UUID", () => {
    expect(SESSION_UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects a path traversal attempt '../../etc/passwd'", () => {
    expect(SESSION_UUID_RE.test("../../etc/passwd")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(SESSION_UUID_RE.test("")).toBe(false);
  });

  it("rejects a UUID with wrong segment lengths", () => {
    expect(SESSION_UUID_RE.test("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });

  it("rejects a UUID missing dashes", () => {
    expect(SESSION_UUID_RE.test("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  it("rejects a string with non-hex characters", () => {
    expect(SESSION_UUID_RE.test("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")).toBe(false);
  });
});

describe("isSessionExpired", () => {
  function metaWithAge(ageMs: number): ForgeMeta {
    return {
      userId: "user-1",
      projectName: "test-proj",
      createdAt: new Date(Date.now() - ageMs).toISOString(),
    };
  }

  it("returns false when createdAt is 59 minutes ago (within TTL)", () => {
    const meta = metaWithAge(59 * 60 * 1000);
    expect(isSessionExpired(meta)).toBe(false);
  });

  it("returns true when createdAt is 61 minutes ago (past TTL)", () => {
    const meta = metaWithAge(61 * 60 * 1000);
    expect(isSessionExpired(meta)).toBe(true);
  });

  it("SESSION_TTL_MS is exactly 1 hour", () => {
    expect(SESSION_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("returns false for a brand-new session (age ≈ 0)", () => {
    const meta = metaWithAge(0);
    expect(isSessionExpired(meta)).toBe(false);
  });

  it("returns true for a session created exactly at TTL + 1ms (just over boundary)", () => {
    const meta = metaWithAge(SESSION_TTL_MS + 1);
    expect(isSessionExpired(meta)).toBe(true);
  });

  it("returns false for a session created at TTL - 1ms (just under boundary)", () => {
    const meta = metaWithAge(SESSION_TTL_MS - 1);
    expect(isSessionExpired(meta)).toBe(false);
  });
});
