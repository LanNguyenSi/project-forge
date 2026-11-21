// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * Pins the baseline security headers declared in next.config.mjs.
 * A framed /login (clickjacking) was the opening; each of the five
 * headers is asserted individually so removing any one fails here.
 */
async function loadHeaders(): Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> {
  const nextConfig = (await import("../../next.config.mjs")).default;
  if (typeof nextConfig.headers !== "function") {
    throw new Error("next.config.mjs defines no headers()");
  }
  return nextConfig.headers();
}

describe("next.config.mjs headers()", () => {
  it("applies to all routes via /:path*", async () => {
    const entries = await loadHeaders();
    expect(entries.map((e) => e.source)).toContain("/:path*");
  });

  it("sets X-Frame-Options: DENY on all routes", async () => {
    const entries = await loadHeaders();
    const all = entries.flatMap((e) => e.headers);
    expect(all).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
  });

  it("sets CSP frame-ancestors 'none' as the only CSP directive", async () => {
    const entries = await loadHeaders();
    const all = entries.flatMap((e) => e.headers);
    const csp = all.filter((h) => h.key === "Content-Security-Policy");
    expect(csp).toEqual([{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }]);
  });

  it("sets X-Content-Type-Options: nosniff on all routes", async () => {
    const entries = await loadHeaders();
    const all = entries.flatMap((e) => e.headers);
    expect(all).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
  });

  it("sets Referrer-Policy: strict-origin-when-cross-origin on all routes", async () => {
    const entries = await loadHeaders();
    const all = entries.flatMap((e) => e.headers);
    expect(all).toContainEqual({ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" });
  });

  it("sets HSTS with a one-year max-age and includeSubDomains, without preload", async () => {
    const entries = await loadHeaders();
    const all = entries.flatMap((e) => e.headers);
    expect(all).toContainEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
    const hsts = all.filter((h) => h.key === "Strict-Transport-Security");
    expect(hsts).toHaveLength(1);
    expect(hsts[0].value).not.toMatch(/preload/i);
  });

  it("carries exactly the five security headers", async () => {
    const entries = await loadHeaders();
    expect(entries.flatMap((e) => e.headers)).toHaveLength(5);
  });
});
