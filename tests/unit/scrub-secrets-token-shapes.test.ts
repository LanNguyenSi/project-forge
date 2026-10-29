import { describe, expect, it } from "vitest";
import { scrubSecrets } from "@/lib/scrub-secrets";

/**
 * Token shapes added to lib/scrub-secrets beyond the original four: prefixed
 * GitHub tokens that sit directly after a word character, and the unprefixed
 * classic 40-hex PAT masked only in credential context. The originals (the
 * URL userinfo forms and the bare time-budget tests) stay pinned in
 * scrub-secrets.test.ts.
 */
const SHA_1 = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_2 = "b2c3d4e5f60718293a4b5c6d7e8f90123456789a";

describe("scrubSecrets prefixed tokens after a word character", () => {
  it("masks gho_/ghp_/ghu_/ghs_ tokens glued to a preceding word character", () => {
    expect(scrubSecrets("my_ghp_AbC123")).toBe("my_ghp_***");
    expect(scrubSecrets("tokenghp_AbC123")).toBe("tokenghp_***");
    expect(scrubSecrets("pushed ghu_Tok3n, retry")).toBe("pushed ghu_***, retry");
  });

  it("masks github_pat_ tokens glued to a preceding word character", () => {
    expect(scrubSecrets("x_github_pat_11ABC")).toBe("x_github_pat_***");
    expect(scrubSecrets("patgithub_pat_11ABC0_DEF!")).toBe("patgithub_pat_***!");
  });

  it("over-masks a word ending in a token prefix (accepted, documented false positive)", () => {
    // Without the leading \b, "highs_" contains "ghs_" and is masked. An
    // error log losing a substring to *** is an acceptable failure mode next
    // to leaking a token; see docs/architecture.md section 7.
    expect(scrubSecrets("highs_traffic report")).toBe("highs_*** report");
  });
});

describe("scrubSecrets context-guarded classic 40-hex PAT", () => {
  it("masks a 40-hex secret after each credential context word and separator form", () => {
    expect(scrubSecrets(`token=${SHA_1}`)).toBe("token=***");
    expect(scrubSecrets(`Authorization: ${SHA_1}`)).toBe("Authorization: ***");
    expect(scrubSecrets(`Authorization: Bearer ${SHA_1}`)).toBe("Authorization: Bearer ***");
    expect(scrubSecrets(`password ${SHA_1}`)).toBe("password ***");
    expect(scrubSecrets(`secret : ${SHA_1}`)).toBe("secret : ***");
    expect(scrubSecrets(`x-access-token:${SHA_1}`)).toBe("x-access-token:***");
    expect(scrubSecrets(`TOKEN:${SHA_1}`)).toBe("TOKEN:***");
  });

  it("masks once when several context words stack before the secret (the closest wins)", () => {
    expect(scrubSecrets(`token password ${SHA_1} done`)).toBe("token password *** done");
  });

  it("does not mask bare 40-hex git SHAs or a 39-hex run after a context word", () => {
    const pushLine = `   ${SHA_1}..${SHA_2}  main -> main`;
    expect(scrubSecrets(pushLine)).toBe(pushLine);
    expect(scrubSecrets(`fatal: bad object ${SHA_2}`)).toBe(`fatal: bad object ${SHA_2}`);
    expect(scrubSecrets(`token=${SHA_1.slice(0, 39)}`)).toBe(`token=${SHA_1.slice(0, 39)}`);
  });

  it("keeps bare SHAs readable in a line that also carries a contextual token", () => {
    const raw = `push ${SHA_1}..${SHA_2} rejected, retry with token=${SHA_1}`;
    expect(scrubSecrets(raw)).toBe(`push ${SHA_1}..${SHA_2} rejected, retry with token=***`);
  });
});

/**
 * Linearity, not wall clock: the 200 ms ceilings in scrub-secrets.test.ts
 * flake under CPU contention, so the new patterns are pinned by scaling
 * instead. A quadratic or exponential regex on the adversarial shape grows
 * super-linearly (quadratic input cost scales with total length here), so a
 * 10x input taking 20x the time fails; a linear one stays near 10x. The
 * absolute ceiling is deliberately generous.
 */
function minElapsedMs(build: () => string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const input = build();
    const t0 = performance.now();
    scrubSecrets(input);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const repeated = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));

function expectNearLinear(
  smallMs: number,
  largeMs: number,
): void {
  expect(largeMs).toBeLessThan(Math.max(smallMs, 1) * 20);
  expect(largeMs).toBeLessThan(2000);
}

describe("scrubSecrets new pattern time budgets (scaling, not absolute)", () => {
  it("scales linearly on 200 KB of gho_/ghp_/ghu_/ghs_ token shapes", () => {
    const unit = `my_ghs_${"0".repeat(36)}-`;
    const small = repeated(unit, 20 * 1024);
    const large = repeated(unit, 200 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(200 * 1024);
    expect(scrubSecrets(large)).toContain("my_ghs_***");
    const smallMs = minElapsedMs(() => small);
    const largeMs = minElapsedMs(() => large);
    expectNearLinear(smallMs, largeMs);
  });

  it("scales linearly on 200 KB of github_pat_ token shapes", () => {
    const unit = `x_github_pat_${"c".repeat(36)}-`;
    const small = repeated(unit, 20 * 1024);
    const large = repeated(unit, 200 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(200 * 1024);
    expect(scrubSecrets(large)).toContain("x_github_pat_***");
    const smallMs = minElapsedMs(() => small);
    const largeMs = minElapsedMs(() => large);
    expectNearLinear(smallMs, largeMs);
  });

  it("scales linearly on 200 KB of near-miss 40-hex context shapes and matches nothing", () => {
    // Adversarial for the context pattern: every anchor consumes the whole
    // separator run and 39 hex characters before failing on "!".
    const unit = `secret${":".repeat(32)}${"a".repeat(39)}!`;
    const small = repeated(unit, 20 * 1024);
    const large = repeated(unit, 200 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(200 * 1024);
    expect(scrubSecrets(large)).toBe(large);
    const smallMs = minElapsedMs(() => small);
    const largeMs = minElapsedMs(() => large);
    expectNearLinear(smallMs, largeMs);
  });
});
