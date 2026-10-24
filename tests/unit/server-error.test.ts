import { describe, expect, it, vi, afterEach } from "vitest";
import { internalErrorDetails, UserFacingError } from "@/lib/server-error";

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
    expect(typeof spy.mock.calls[0][1]).toBe("string");
    expect(spy.mock.calls[0][1]).toContain("boom");
  });

  describe("scrubs credentials before logging", () => {
    const cases: Array<[string, string, string]> = [
      ["ghp_ token", "Invalid `prisma.user.update()` data: { githubPat: 'ghp_abcDEF123456' }", "ghp_abcDEF123456"],
      ["github_pat_ token", "failed with github_pat_11AAAA_bbbCCC999", "github_pat_11AAAA_bbbCCC999"],
      ["x-access-token remote", "fatal: unable to access 'https://x-access-token:SEKRET9@github.com/o/r.git'", "SEKRET9"],
      ["userinfo remote", "fatal: unable to access 'https://SEKRET8@github.com/o/r.git'", "SEKRET8"],
    ];
    for (const [name, message, secret] of cases) {
      it(`${name} never reaches console.error (message and stack)`, () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const err = new Error(message);
        err.stack = `Error: ${message}\n    at fn (file.ts:1:1)`;
        const out = internalErrorDetails("scope", err);
        const logged = spy.mock.calls.flat().map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        expect(logged).not.toContain(secret);
        expect(logged).toContain("***");
        expect(out).not.toContain(secret);
      });
    }

    it("scrubs a non-Error throwable", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      internalErrorDetails("s", "token ghp_plainThrown1");
      expect(spy.mock.calls.flat().join(" ")).not.toContain("ghp_plainThrown1");
    });
  });

  it("passes a UserFacingError message through, scrubbed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(internalErrorDetails("s", new UserFacingError("Invalid or expired GitHub PAT"))).toBe(
      "Invalid or expired GitHub PAT",
    );
    expect(internalErrorDetails("s", new UserFacingError("leak ghp_inMessage1"))).toBe("leak ghp_***");
  });

  it("does not pass through a plain Error with the same text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(internalErrorDetails("s", new Error("Invalid or expired GitHub PAT"))).toMatch(/^An internal error/);
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
