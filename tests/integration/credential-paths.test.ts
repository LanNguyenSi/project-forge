import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Structural guard for the cutoff that a claimed legacy row sets (see
 * lib/session-cutoff.ts, which lists the same paths in prose). Every server
 * file that reads or writes `githubPat`, authenticates with an API token
 * (`validateApiToken`) or reads the session (`getServerSession`) has to be
 * listed here with the way it honours the cutoff, and the test checks that
 * the file still shows that way. A new file that touches one of those and is
 * not listed fails the test, so adding a credential-yielding path forces the
 * question; the behaviour itself is covered by
 * legacy-claim-revokes-credentials.test.ts.
 */

const ROOT = path.join(__dirname, "..", "..");

type Entry =
  | { how: "claim"; why: string }
  | { how: "token-check"; why: string }
  /** Authenticates with an API token through validateApiToken, which applies the cutoff. */
  | { how: "api-token"; why: string }
  /** Applies isStaleSession to the state it uses. */
  | { how: "session-cutoff"; why: string }
  /** Reads the session or the token but yields and overwrites no credential. */
  | { how: "no-credential"; why: string }
  | { how: "broker"; why: string }
  | { how: "text-only"; why: string }
  /** Rewrites the token it was handed, only while the row still holds that same value. */
  | { how: "same-value-rewrite"; why: string };

const INVENTORY: Record<string, Entry> = {
  "lib/auth.ts": { how: "claim", why: "writes githubPat at sign-in and, when claiming a legacy row, sets the cutoff and revokes its API tokens in one transaction" },
  "lib/db.ts": { how: "token-check", why: "validateApiToken refuses a token created at or before the cutoff" },
  "lib/session-cutoff.ts": { how: "text-only", why: "the helpers and the inventory comment" },
  "lib/scrub-secrets.ts": { how: "text-only", why: "masking pattern for log text" },
  "lib/github-pat.ts": { how: "same-value-rewrite", why: "re-encrypts a legacy plaintext token with a compare-and-swap on the value the caller read, so a claim or reconnect in between is never overwritten" },
  "app/api/v1/publish/route.ts": { how: "api-token", why: "pushes with the githubPat of the user row validateApiToken returned" },
  "app/api/v1/projects/route.ts": { how: "api-token", why: "pushes with the githubPat of the user row validateApiToken returned" },
  "app/api/v1/preview/route.ts": { how: "no-credential", why: "API token, reads no credential" },
  "app/api/v1/generate/route.ts": { how: "no-credential", why: "API token, reads no credential" },
  "app/api/dashboard/pat/route.ts": { how: "session-cutoff", why: "GET reads the cutoff with the token, POST carries it in the update WHERE" },
  "app/api/dashboard/tokens/route.ts": { how: "session-cutoff", why: "re-reads the cutoff after creating a token and revokes it when stale" },
  "app/api/publish/route.ts": { how: "session-cutoff", why: "cutoff from the row read that supplies the token" },
  "app/api/dashboard/route.ts": { how: "no-credential", why: "only says whether a usable token exists (readGithubPat decides, the value is never returned)" },
  "app/api/dashboard/tokens/[id]/route.ts": { how: "no-credential", why: "revokes the caller's own token" },
  "app/api/generate/route.ts": { how: "no-credential", why: "session id only" },
  "app/api/ai-assist/route.ts": { how: "no-credential", why: "session id only" },
  "app/api/auth/register-from-project-pilot/route.ts": { how: "broker", why: "verified GitHub token, rows matched by githubId, never claims a row without one" },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const stat = statSync(path.join(ROOT, rel));
    if (stat.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");
const TOUCHES = /validateApiToken|getServerSession|githubPat/;

const touching = [...sourceFiles("app/api"), ...sourceFiles("lib")].filter((f) => TOUCHES.test(read(f))).sort();

describe("credential-yielding paths and the cutoff", () => {
  it("every server file that touches githubPat, validateApiToken or getServerSession is in the inventory", () => {
    expect(touching.filter((f) => !(f in INVENTORY))).toEqual([]);
  });

  it("the inventory lists no file that no longer exists or no longer touches them", () => {
    expect(Object.keys(INVENTORY).filter((f) => !touching.includes(f))).toEqual([]);
  });

  for (const [file, entry] of Object.entries(INVENTORY)) {
    it(`${file} (${entry.how}) still shows how it honours the cutoff`, () => {
      const src = read(file);
      switch (entry.how) {
        case "claim":
          expect(src).toMatch(/sessionsValidAfter: claimedAt/);
          expect(src).toMatch(/tx\.apiToken\.updateMany/);
          expect(src).toMatch(/isStaleSession\(token\.authAt/);
          break;
        case "token-check":
          expect(src).toMatch(/tokenPredatesCutoff\(record\.createdAt, user\.sessionsValidAfter\)/);
          // The user row is its own read after the token row.
          expect(src).toMatch(/prisma\.user\.findUnique\(\{ where: \{ id: record\.userId \} \}\)/);
          expect(src).not.toMatch(/include:\s*\{\s*user/);
          break;
        case "api-token":
          expect(src).toMatch(/validateApiToken\(/);
          expect(src).toMatch(/tokenRecord\.user/);
          // A second read of the user row would bypass the checked one.
          expect(src).not.toMatch(/prisma\.user\./);
          break;
        case "session-cutoff":
          expect(src).toMatch(/from "@\/lib\/session-cutoff"/);
          expect(src).toMatch(/isStaleSession\(session\.authAt/);
          break;
        case "no-credential": {
          // May say whether a token exists, never read its value.
          const rest = src.replace(/!!user\.githubPat/g, "").replace(/githubPatConnected/g, "");
          expect(rest).not.toMatch(/githubPat/);
          expect(src).not.toMatch(/\.user\.githubPat|tokenRecord\.user\.github/);
          break;
        }
        case "broker":
          expect(src).toMatch(/findUnique\(\{ where: \{ githubId \} \}\)/);
          expect(src).toMatch(/existingByEmail && !existingByEmail\.githubId/);
          break;
        case "same-value-rewrite":
          expect(src).toMatch(/where: \{ id: user\.id, githubPat: stored \}/);
          break;
        case "text-only":
          break;
      }
    });
  }
});
