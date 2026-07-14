import { describe, expect, it, beforeAll } from "vitest";
import { hashApiToken as libHashApiToken, tokenPrefixOf as libTokenPrefixOf } from "@/lib/db";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scriptHash = require("../../scripts/backfill-api-token-hashes.js") as {
  hashApiToken: (rawToken: string) => string;
  tokenPrefixOf: (rawToken: string) => string;
};

/**
 * Drift guard for the deliberate duplication between lib/db.ts's
 * hashApiToken()/tokenPrefixOf() and their re-implementation in
 * scripts/backfill-api-token-hashes.js (a plain-CJS ops script that can't
 * `import` the TS module directly — see that script's header comment).
 * If either formula ever changes without updating the other, this test
 * fails instead of the drift silently producing tokens the migration
 * script would hash differently from the app.
 */
describe("hash-parity: lib/db.ts vs scripts/backfill-api-token-hashes.js", () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "shared-parity-test-secret";
  });

  it("produce identical hashApiToken output for the same input and secret", () => {
    const raw = "pf_someRepresentativeRawTokenValue123";
    expect(scriptHash.hashApiToken(raw)).toBe(libHashApiToken(raw));
  });

  it("produce identical tokenPrefixOf output for the same input", () => {
    const raw = "pf_anotherRawTokenValueForPrefixCheck";
    expect(scriptHash.tokenPrefixOf(raw)).toBe(libTokenPrefixOf(raw));
  });
});
