import { describe, expect, it } from "vitest";
import { scrubSecrets } from "@/lib/scrub-secrets";

/**
 * Log-side credential masking (lib/scrub-secrets); the client-facing side is
 * pinned in summarize-publish-error.test.ts. Also a time budget for the
 * x-access-token pattern: an unbounded `[^@]+` class backtracks quadratically
 * when the text repeats the `x-access-token:` prefix without a closing `@`,
 * so the class stays bounded (`[^@\s/]`).
 */
describe("scrubSecrets", () => {
  it("masks the x-access-token userinfo form and keeps the rest of the URL", () => {
    expect(scrubSecrets("push to https://x-access-token:ghs_abc@github.com/o/r.git failed")).toBe(
      "push to https://***@github.com/o/r.git failed",
    );
  });

  it("masks plain https userinfo and bare GitHub token shapes", () => {
    const out = scrubSecrets(
      "https://ghu_tok@github.com/o/r ghp_AbC123 gho_x ghs_y github_pat_11ABC0_DEF",
    );
    expect(out).toContain("https://***@github.com/o/r");
    expect(out).toContain("ghp_***");
    expect(out).toContain("gho_***");
    expect(out).toContain("ghs_***");
    expect(out).toContain("github_pat_***");
    expect(out).not.toContain("AbC123");
    expect(out).not.toContain("11ABC0_DEF");
  });

  it("leaves an x-access-token prefix with no closing @ untouched", () => {
    expect(scrubSecrets("x-access-token:")).toBe("x-access-token:");
  });

  it("handles 200 KB of repeated x-access-token line prefixes in under 200 ms", () => {
    // Realistic adversarial stderr: many log lines each ending in the
    // credential prefix with no closing "@" (newline-separated). An
    // unbounded [^@]+ class then backtracks across every following line
    // from every anchor position (quadratic); the capped run excludes the
    // separator and fails each anchor in one step (linear).
    const evil = "x-access-token:\n".repeat(Math.ceil((200 * 1024) / 16));
    expect(evil.length).toBeGreaterThanOrEqual(200 * 1024);
    const t0 = performance.now();
    const out = scrubSecrets(evil);
    const elapsedMs = performance.now() - t0;
    expect(out).toBe(evil);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("handles 200 KB of x-access-token prefixes with no separator in under 200 ms", () => {
    // Without whitespace or "/" between the repeats only the length cap
    // keeps the scan linear.
    const evil = "x-access-token:".repeat(Math.ceil((200 * 1024) / 15));
    const t0 = performance.now();
    const out = scrubSecrets(evil);
    const elapsedMs = performance.now() - t0;
    expect(out).toBe(evil);
    expect(elapsedMs).toBeLessThan(200);
  });

  it("still masks a long but realistic token", () => {
    const token = "ghs_" + "a".repeat(200);
    expect(scrubSecrets(`https://x-access-token:${token}@github.com/o/r.git`)).toBe("https://***@github.com/o/r.git");
  });
});
