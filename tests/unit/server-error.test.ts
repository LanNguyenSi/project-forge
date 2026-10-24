import { describe, expect, it, vi, afterEach } from "vitest";
import { internalErrorDetails } from "@/lib/server-error";

describe("internalErrorDetails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a generic sentence with an 8-char reference id and no error text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = internalErrorDetails("scope", new Error("SELECT secret FROM users"));
    expect(out).toMatch(/^An internal error occurred\. Reference: [0-9a-f]{8}$/);
    expect(out).not.toContain("SELECT");
  });

  it("logs the full error server-side under the same reference id", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    const out = internalErrorDetails("my scope", err);
    const ref = out.split("Reference: ")[1];
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(`[${ref}] my scope:`);
    expect(spy.mock.calls[0][1]).toBe(err);
  });

  it("handles non-Error throwables without leaking their value", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(internalErrorDetails("s", "token=abc123")).not.toContain("abc123");
  });

  it("uses a fresh reference id per call", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(internalErrorDetails("s", 1)).not.toBe(internalErrorDetails("s", 1));
  });
});
