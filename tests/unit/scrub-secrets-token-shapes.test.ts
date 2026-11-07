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

  it("keeps a SHA after an ordinary word that only contains a context word", () => {
    // "pat" and "token" must end the word right before the separators, so
    // words like path, patch or tokens do not turn a following SHA into a
    // masked value.
    for (const word of ["path", "patch", "compatible", "dispatch", "update", "tokens"]) {
      const line = `${word} ${SHA_1}`;
      expect(scrubSecrets(line)).toBe(line);
    }
  });

  it("masks a git SHA that follows a context word (accepted, documented false positive)", () => {
    // "secret <sha>" reads like a credential assignment to the pattern, so
    // the SHA is masked; an error log losing a substring to *** is the
    // accepted price of the context-guarded classic-PAT mask (the same
    // trade-off as highs_*** above, see docs/architecture.md section 7).
    expect(scrubSecrets(`rotate the secret ${SHA_2} now`)).toBe("rotate the secret *** now");
  });
});

describe("scrubSecrets http userinfo", () => {
  it("masks http userinfo carrying a classic PAT and keeps the scheme and host", () => {
    expect(scrubSecrets(`fatal: unable to access 'http://user:${SHA_1}@host.example/o/r.git/'`)).toBe(
      "fatal: unable to access 'http://***@host.example/o/r.git/'",
    );
    expect(scrubSecrets(`http://user:${SHA_1}@host`)).toBe("http://***@host");
  });

  it("masks https userinfo carrying a classic PAT (user name is masked with the token)", () => {
    expect(scrubSecrets(`https://user:${SHA_1}@host/o/r`)).toBe("https://***@host/o/r");
  });

  it("leaves an http URL without userinfo and a bare SHA in a URL path untouched", () => {
    const line = `see http://host.example/o/r/commit/${SHA_1} and http://host.example:8080/x`;
    expect(scrubSecrets(line)).toBe(line);
  });
});

describe("scrubSecrets context word with a name suffix", () => {
  it("masks a 40-hex value after token_value, password_hash, secret_key and secret-string", () => {
    expect(scrubSecrets(`token_value=${SHA_1}`)).toBe("token_value=***");
    expect(scrubSecrets(`password_hash: ${SHA_1}`)).toBe("password_hash: ***");
    expect(scrubSecrets(`secret_key=${SHA_1}`)).toBe("secret_key=***");
    expect(scrubSecrets(`secret.string: ${SHA_1}`)).toBe("secret.string: ***");
    expect(scrubSecrets(`tokenValue=${SHA_1}`)).toBe("tokenValue=***");
    expect(scrubSecrets(`secret-hash ${SHA_1}`)).toBe("secret-hash ***");
  });

  it("accepts the false positive of a SHA after a suffixed context word", () => {
    expect(scrubSecrets(`secret_key ${SHA_2} rotated`)).toBe("secret_key *** rotated");
  });

  it("keeps a SHA after a suffix that is not on the list", () => {
    for (const word of ["token_count", "password_length", "secret_id", "tokenizer", "key"]) {
      const line = `${word}=${SHA_1}`;
      expect(scrubSecrets(line)).toBe(line);
    }
  });
});

describe("scrubSecrets quote shapes around the key and the value", () => {
  it("masks a value behind JSON-escaped quotes", () => {
    expect(scrubSecrets(`{\\"token\\": \\"${SHA_1}\\"}`)).toBe(`{\\"token\\": \\"***\\"}`);
    expect(scrubSecrets(`{\\\\"token\\\\": \\\\"${SHA_1}\\\\"}`)).toBe(`{\\\\"token\\\\": \\\\"***\\\\"}`);
  });

  it("masks a value behind a backtick on the key and on the value", () => {
    expect(scrubSecrets(`\`token\`: ${SHA_1}`)).toBe("`token`: ***");
    expect(scrubSecrets(`token: \`${SHA_1}\``)).toBe("token: `***`");
  });

  it("masks a value behind typographic single quotes on the key and on the value", () => {
    expect(scrubSecrets(`‘token’: ${SHA_1}`)).toBe("‘token’: ***");
    expect(scrubSecrets(`token: ‘${SHA_1}’`)).toBe("token: ‘***’");
    expect(scrubSecrets(`token’: ${SHA_1}`)).toBe("token’: ***");
    expect(scrubSecrets(`token: ’${SHA_1}`)).toBe("token: ’***");
  });

  it("masks a value behind typographic double quotes on the key and on the value", () => {
    expect(scrubSecrets(`“token”: ${SHA_1}`)).toBe("“token”: ***");
    expect(scrubSecrets(`token: “${SHA_1}”`)).toBe("token: “***”");
    expect(scrubSecrets(`token”: ${SHA_1}`)).toBe("token”: ***");
    expect(scrubSecrets(`token: ”${SHA_1}`)).toBe("token: ”***");
  });

  it("masks a value behind a plain single quote on the key and any quote class member right after the word", () => {
    expect(scrubSecrets(`{'token': '${SHA_1}'}`)).toBe("{'token': '***'}");
    // The key group sits right after the context word, so a stray opening
    // typographic quote there is accepted the same as a closing one.
    expect(scrubSecrets(`token\u2018: ${SHA_1}`)).toBe("token\u2018: ***");
    expect(scrubSecrets(`token\u201C: ${SHA_1}`)).toBe("token\u201C: ***");
  });

  it("keeps a SHA behind a quote that follows no context word", () => {
    for (const q of ["\\\"", "`", "‘", "“", "'"]) {
      const line = `commit ${q}${SHA_1}${q}`;
      expect(scrubSecrets(line)).toBe(line);
    }
  });
});

describe("scrubSecrets arrow separators", () => {
  it("masks a value after => and ->", () => {
    expect(scrubSecrets(`token => ${SHA_1}`)).toBe("token => ***");
    expect(scrubSecrets(`{ token=>"${SHA_1}" }`)).toBe('{ token=>"***" }');
    expect(scrubSecrets(`password -> ${SHA_1}`)).toBe("password -> ***");
    expect(scrubSecrets(`secret->${SHA_1}`)).toBe("secret->***");
  });

  it("keeps SHAs in a git push line and a commit range", () => {
    const push = `   ${SHA_1}..${SHA_2}  main -> main`;
    expect(scrubSecrets(push)).toBe(push);
    const forced = ` + ${SHA_1}...${SHA_2} main -> main (forced update)`;
    expect(scrubSecrets(forced)).toBe(forced);
    const rejected = ` ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: ${SHA_1}...${SHA_2}`;
    expect(scrubSecrets(rejected)).toBe(rejected);
    const range = `git log ${SHA_1}...${SHA_2}`;
    expect(scrubSecrets(range)).toBe(range);
  });

  it("keeps a SHA after a single > or - that is not an arrow", () => {
    for (const sep of [">", "-", "=="]) {
      const line = `main ${sep} ${SHA_1}`;
      expect(scrubSecrets(line)).toBe(line);
    }
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

  it("scales linearly on adversarial repeats of the widened context pattern", () => {
    // One input per added piece: a repeated suffixed context word, a repeated
    // key quote (plain and escaped), a repeated arrow separator, repeated
    // typographic quotes and a repeated backslash. Each ends in "!" so
    // nothing masks and every anchor fails after consuming its run.
    const hex39 = "a".repeat(39);
    const units = [
      "token_value",
      `token${'"'.repeat(64)}${hex39}!`,
      `token${"\\\"".repeat(64)}${hex39}!`,
      `password_hash${"=>".repeat(64)}${hex39}!`,
      `secret${"->".repeat(64)}${hex39}!`,
      `pat${"“’".repeat(64)}:${hex39}!`,
      `token${"\\".repeat(64)}`,
      `token_hash${"=".repeat(64)}`,
    ];
    for (const unit of units) {
      const small = repeated(unit, 200 * 1024);
      const large = repeated(unit, 2000 * 1024);
      expect(large.length).toBeGreaterThanOrEqual(2000 * 1024);
      expect(scrubSecrets(large)).toBe(large);
      expectNearLinear(minElapsedMs(() => small), minElapsedMs(() => large));
    }
  });

  it("scales linearly on repeated http and https userinfo prefixes without an @", () => {
    for (const unit of ["https://a:", "http://a:", "https://a:b", "http://"]) {
      const small = repeated(unit, 200 * 1024);
      const large = repeated(unit, 2000 * 1024);
      expect(scrubSecrets(large)).toBe(large);
      expectNearLinear(minElapsedMs(() => small), minElapsedMs(() => large));
    }
  });
});
