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
// still accepted, and readGithubPat rewrites it encrypted on its first use.

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
  // A wrong IV, tag or ciphertext (including a wrong length) fails the GCM
  // authentication below, so it needs no separate check.
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return plain || null;
  } catch {
    return null;
  }
}

type PatClient = { user: { updateMany: (args: { where: { id: string; githubPat: string }; data: { githubPat: string } }) => Promise<unknown> } };

/**
 * The user's usable GitHub token, or null ("not connected"). A legacy
 * plaintext value is rewritten encrypted on this first use. The rewrite is a
 * compare-and-swap on the value just read, so it is idempotent and never
 * replaces a token another request wrote in between (a reconnect, a sign-in
 * or a legacy-row claim). A failed rewrite is not logged and not fatal: the
 * token is still returned and the next use tries again.
 */
export async function readGithubPat(
  user: { id: string; githubPat: string | null },
  client: PatClient = prisma
): Promise<string | null> {
  const stored = user.githubPat;
  const plain = decryptGithubPat(stored);
  if (plain && stored && !isEncryptedGithubPat(stored)) {
    try {
      await client.user.updateMany({
        where: { id: user.id, githubPat: stored },
        data: { githubPat: encryptGithubPat(plain) },
      });
    } catch {
      // Left as it is; retried on the next use.
    }
  }
  return plain;
}
