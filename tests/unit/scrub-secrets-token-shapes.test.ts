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

  it("masks a secret whose context word sits inside an env or camelCase name", () => {
    // No leading word boundary on the context pattern, so the word counts
    // after `_` or a letter too, and `pat` covers githubPat and github_pat=.
    expect(scrubSecrets(`GITHUB_TOKEN=${SHA_1}`)).toBe("GITHUB_TOKEN=***");
    expect(scrubSecrets(`GH_TOKEN: ${SHA_1}`)).toBe("GH_TOKEN: ***");
    expect(scrubSecrets(`access_token=${SHA_1}&scope=repo`)).toBe("access_token=***&scope=repo");
    expect(scrubSecrets(`db_password=${SHA_1}`)).toBe("db_password=***");
    expect(scrubSecrets(`github_pat=${SHA_1}`)).toBe("github_pat=***");
    // The most likely logged shape in this repo: a Prisma error embedding
    // the User.githubPat argument value (prisma/schema.prisma, githubPat).
    expect(scrubSecrets(`data: { githubPat: "${SHA_1}" }`)).toBe('data: { githubPat: "***" }');
  });

  it("masks a secret behind one optional quote around the separators", () => {
    expect(scrubSecrets(`{"token": "${SHA_1}"}`)).toBe('{"token": "***"}');
    expect(scrubSecrets(`token: "${SHA_1}"`)).toBe('token: "***"');
    expect(scrubSecrets(`token='${SHA_1}'`)).toBe("token='***'");
    expect(scrubSecrets(`githubPat: "${SHA_1}"`)).toBe('githubPat: "***"');
  });

  it("keeps a 40-hex git SHA in prose that follows no context word", () => {
    const prose = `the base commit ${SHA_1} predates the release ${SHA_2}`;
    expect(scrubSecrets(prose)).toBe(prose);
  });

  it("masks a git SHA that follows a context word (accepted, documented false positive)", () => {
    // "secret <sha>" reads like a credential assignment to the pattern, so
    // the SHA is masked; an error log losing a substring to *** is the
    // accepted price of the context-guarded classic-PAT mask (the same
    // trade-off as highs_*** above, see docs/architecture.md section 7).
    expect(scrubSecrets(`rotate the secret ${SHA_2} now`)).toBe("rotate the secret *** now");
  });
});

/**
 * Linearity, not wall clock: the 200 ms ceilings in scrub-secrets.test.ts
 * flake under CPU contention, so these patterns are pinned by scaling
 * instead. Each case scrubs a 200 KB and a 2 MB adversarial input (10x the
 * input; both sides take well over a timer tick, so the measured ratio is
 * meaningful) and requires the 2 MB time to stay under 20x the 200 KB time:
 * a linear pattern grows about 10x, a quadratic or exponential one grows
 * about 100x or more. The 2000 ms absolute ceiling on the 2 MB run is
 * deliberately generous and only bounds the worst case per pass.
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

function expectNearLinear(smallMs: number, largeMs: number): void {
  expect(largeMs).toBeLessThan(smallMs * 20);
  expect(largeMs).toBeLessThan(2000);
}

describe("scrubSecrets new pattern time budgets (scaling, not absolute)", () => {
  it("scales linearly on 2 MB of gho_/ghp_/ghu_/ghs_ token shapes", () => {
    const unit = `my_ghs_${"0".repeat(36)}-`;
    const small = repeated(unit, 200 * 1024);
    const large = repeated(unit, 2000 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(2000 * 1024);
    expect(scrubSecrets(large)).toContain("my_ghs_***");
    const smallMs = minElapsedMs(() => small);
    const largeMs = minElapsedMs(() => large);
    expectNearLinear(smallMs, largeMs);
  });

  it("scales linearly on 2 MB of github_pat_ token shapes", () => {
    const unit = `x_github_pat_${"c".repeat(36)}-`;
    const small = repeated(unit, 200 * 1024);
    const large = repeated(unit, 2000 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(2000 * 1024);
    expect(scrubSecrets(large)).toContain("x_github_pat_***");
    const smallMs = minElapsedMs(() => small);
    const largeMs = minElapsedMs(() => large);
    expectNearLinear(smallMs, largeMs);
  });

  it("scales linearly on 2 MB of near-miss context shapes and matches nothing", () => {
    // Adversarial for the context pattern: every anchor consumes the whole
    // separator run and the trailing optional quote, then 39 hex characters,
    // before failing on "!". The anchors cover the plain (`secret`),
    // underscore (`db_password`) and camelCase-with-quote (`githubPat: '...`)
    // forms of the widened context. Anchors are spaced by ~7 KB of inert
    // filler rather than packed: packed, an accidental unbounded lazy scan
    // between context and hex (e.g. [\s\S]*?) would need minutes per pass
    // and hang the suite; spaced, it still grows quadratically and fails the
    // ratio below within seconds.
    const sep = ":".repeat(32);
    const hex39 = "a".repeat(39);
    const filler = "work log line ok ".repeat(400);
    const variants = [
      `secret${sep}${hex39}!`,
      `db_password${sep}${hex39}!`,
      `githubPat:${sep}'${hex39}!`,
    ];
    const build = (bytes: number) => {
      let s = "";
      for (let i = 0; s.length < bytes; i++) {
        s += variants[i % variants.length] + filler;
      }
      return s;
    };
    const small = build(200 * 1024);
    const large = build(2000 * 1024);
    expect(large.length).toBeGreaterThanOrEqual(2000 * 1024);
    expect(scrubSecrets(large)).toBe(large);
    const smallMs = minElapsedMs(() => small);
    const largeMs = minElapsedMs(() => large);
    expectNearLinear(smallMs, largeMs);
  });
});
