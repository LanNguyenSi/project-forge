/**
 * Mask GitHub credentials in free text before it is logged or returned.
 *
 * A failed `git push` to an authed remote echoes the URL (and so the token)
 * in git's stderr, and Prisma errors can embed argument values. Handles the
 * `x-access-token:TOKEN@` and `https://TOKEN@` remote forms plus bare GitHub
 * token shapes as defense in depth.
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // Capped length (a token is far shorter than 256 characters): an
      // unbounded run backtracks quadratically on input that repeats
      // "x-access-token:" with no closing "@". The bare-token patterns below
      // still mask a longer token.
      .replace(/x-access-token:[^@\s/]{1,256}@/g, "x-access-token:***@")
      .replace(/https:\/\/[^@\s/]+@/g, "https://***@")
      .replace(/\b(gho|ghp|ghu|ghs)_[A-Za-z0-9]+/g, "$1_***")
      .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***")
  );
}
