import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { prisma } from "./db";

// GitHub tokens (`User.githubPat`: an OAuth `gho_` token or a manually entered
// PAT, both with repo scope) are encrypted at rest with AES-256-GCM. The
// column holds a versioned, self-describing string:
//
//   v1:<iv>:<tag>:<ciphertext>      (each part base64url, iv 12 bytes, tag 16)
//
// Key: GITHUB_PAT_ENCRYPTION_KEY when set (non-empty), otherwise
// NEXTAUTH_SECRET, the same fallback API_TOKEN_HASH_SECRET uses in lib/db.ts.
// Either value is fed through HKDF-SHA256 with a fixed info string that names
// this purpose, so the AES key never equals the session secret or any other
// key derived from the same value. Changing whichever value is in effect makes
// every stored token unreadable: decryptGithubPat then returns null, the user
// counts as "GitHub not connected" and connects again. Nothing is logged.
//
// A stored value without the `v1:` prefix is a token from before encryption
// (GitHub tokens start with gho_, ghp_ or github_pat_, never with `v1:`). It is
// still accepted; readGithubPat rewrites it encrypted on its first use, and the
// start-up sweep (sweepLegacyGithubPats, started from instrumentation.ts)
// rewrites the rest.

const PREFIX = "v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_INFO = "project-forge github-pat aes-256-gcm v1";

type Env = Record<string, string | undefined>;

function deriveKey(env: Env): Buffer | null {
  const material = env.GITHUB_PAT_ENCRYPTION_KEY || env.NEXTAUTH_SECRET;
  if (!material) return null;
  return Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

export function isEncryptedGithubPat(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Encrypts a token for storage. Throws when no key is configured. */
export function encryptGithubPat(plain: string, env: Env = process.env): string {
  const key = deriveKey(env);
  if (!key) {
    throw new Error(
      "GITHUB_PAT_ENCRYPTION_KEY (or NEXTAUTH_SECRET) must be set to store GitHub tokens"
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${[iv, tag, ciphertext].map((part) => part.toString("base64url")).join(":")}`;
}

/**
 * The stored value as a usable token, or null when there is none or it cannot
 * be read (wrong or missing key, tampered or malformed value). A value without
 * the version prefix is legacy plaintext and is returned as it is.
 */
export function decryptGithubPat(stored: string | null | undefined, env: Env = process.env): string | null {
  if (!stored) return null;
  if (!isEncryptedGithubPat(stored)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) return null;
  const key = deriveKey(env);
  if (!key) return null;
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  // Exact lengths, checked here and not left to authTagLength alone: a
  // truncated tag must never be accepted, whatever the Node version does.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plain || null;
  } catch {
    return null;
  }
}

type UpdateManyArgs = { where: { id: string; githubPat: string }; data: { githubPat: string } };
type PatClient = { user: { updateMany: (args: UpdateManyArgs) => Promise<{ count: number } | unknown> } };

/**
 * Rewrites one legacy plaintext value encrypted: a compare-and-swap on the
 * value the caller read, so it is idempotent and never replaces a token
 * another request wrote in between (a reconnect, a sign-in or a legacy-row
 * claim). True when this call wrote the row. Throws on a database error or
 * when no key is configured.
 */
async function rewriteLegacy(
  client: PatClient,
  user: { id: string },
  stored: string,
  plain: string,
  env: Env = process.env
): Promise<boolean> {
  const result = await client.user.updateMany({
    where: { id: user.id, githubPat: stored },
    data: { githubPat: encryptGithubPat(plain, env) },
  });
  return (result as { count?: number } | null)?.count === 1;
}

/**
 * The user's usable GitHub token, or null ("not connected"). A legacy
 * plaintext value is rewritten encrypted on this first use (see
 * rewriteLegacy). A failed rewrite is not logged and not fatal: the token is
 * still returned and the next use, or the start-up sweep, tries again.
 */
export async function readGithubPat(
  user: { id: string; githubPat: string | null },
  client: PatClient = prisma
): Promise<string | null> {
  const stored = user.githubPat;
  const plain = decryptGithubPat(stored);
  if (plain && stored && !isEncryptedGithubPat(stored)) {
    try {
      await rewriteLegacy(client, user, stored, plain);
    } catch {
      // Left as it is; retried on the next use.
    }
  }
  return plain;
}

type SweepClient = PatClient & {
  user: {
    findMany: (args: {
      where: object;
      orderBy: { id: "asc" };
      take: number;
      select: { id: true; githubPat: true };
    }) => Promise<Array<{ id: string; githubPat: string | null }>>;
  };
};

export type SweepResult = { skipped: boolean; rewritten: number; failed: number };

export const SWEEP_BATCH_SIZE = 100;

/**
 * One pass over every row whose githubPat is set and not in the encrypted
 * form, in batches ordered by id (a cursor on id, so rows that stay as they
 * are, such as an empty string, do not stop the pass). Each row goes through
 * the same compare-and-swap as readGithubPat, so a second instance sweeping
 * at the same time, a restart, or a reconnect in between never overwrites a
 * newer value. Skipped entirely when no key is configured.
 */
export async function sweepLegacyGithubPats(
  client: SweepClient = prisma,
  env: Env = process.env,
  batchSize: number = SWEEP_BATCH_SIZE
): Promise<SweepResult> {
  const result: SweepResult = { skipped: false, rewritten: 0, failed: 0 };
  if (!deriveKey(env)) return { ...result, skipped: true };
  let after: string | undefined;
  for (;;) {
    const rows = await client.user.findMany({
      where: {
        githubPat: { not: null },
        NOT: { githubPat: { startsWith: PREFIX } },
        ...(after === undefined ? {} : { id: { gt: after } }),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, githubPat: true },
    });
    for (const row of rows) {
      const plain = decryptGithubPat(row.githubPat, env);
      // The query already left out encrypted rows; an unreadable value is skipped.
      if (!plain || !row.githubPat) continue;
      try {
        if (await rewriteLegacy(client, row, row.githubPat, plain, env)) result.rewritten += 1;
      } catch {
        result.failed += 1;
      }
    }
    if (rows.length < batchSize) return result;
    after = rows[rows.length - 1].id;
  }
}

/**
 * Starts the sweep without waiting for it: the server serves while it runs.
 * Logs counts only, never a token value or a database error text.
 */
export function startLegacyGithubPatSweep(client: SweepClient = prisma): void {
  sweepLegacyGithubPats(client)
    .then(({ skipped, rewritten, failed }) => {
      if (skipped) return;
      if (rewritten > 0 || failed > 0) {
        console.info(`GitHub token sweep: ${rewritten} legacy token(s) encrypted, ${failed} failed`);
      }
    })
    .catch(() => {
      console.error("GitHub token sweep stopped: the database query failed; tokens are encrypted on first use");
    });
}
