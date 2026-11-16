/**
 * Claiming a legacy GitHub-only row (signInWithGithub in lib/auth.ts) writes the
 * new owner's OAuth token into `User.githubPat` and, in the same transaction,
 * sets `User.sessionsValidAfter` (the cutoff) and revokes the row's API tokens.
 * Whatever authenticated before that moment must not read, overwrite or use the
 * token. Two helpers decide it, one per credential carrier:
 *
 *  - isStaleSession: a NextAuth session carries its mint time (`authAt`).
 *  - tokenPredatesCutoff: an API token carries `createdAt`.
 *
 * A check made when the request is authenticated is not enough, because the
 * claim can commit between that check and the use. Every path that reads or
 * writes `githubPat` therefore applies the cutoff to the same read (or the
 * same write) that supplies or changes the token. Inventory of those paths
 * (tests/integration/credential-paths.test.ts keeps it complete: a file that reads
 * githubPat, calls validateApiToken or getServerSession and is not listed
 * there fails the test):
 *
 *   lib/auth.ts signInWithGithub   writes githubPat; authenticated by the
 *                                  verified GitHub sign-in; the claim itself
 *   lib/db.ts validateApiToken     API token; refuses a revoked token and one
 *                                  created at or before the cutoff, with the
 *                                  user row read after the token row
 *   app/api/v1/publish             API token, via validateApiToken, which
 *   app/api/v1/projects            returns the user row it checked
 *   app/api/v1/preview, generate   API token, via validateApiToken; no
 *                                  credential is read or used
 *   app/api/dashboard/pat GET      session; cutoff in the same read as the token
 *   app/api/dashboard/pat POST     session; cutoff in the WHERE of the update
 *   app/api/dashboard/tokens POST  session; cutoff re-read after the create,
 *                                  the new token is revoked when stale
 *   app/api/publish                session; cutoff in the row read that
 *                                  supplies the token
 *   app/api/dashboard (GET)        session; only says whether a token exists
 *   app/api/dashboard/tokens/[id]  session; revokes the caller's own token
 *   app/api/generate, ai-assist    session; no credential involved
 *   app/api/auth/register-from-project-pilot
 *                                  broker; authenticated by a verified GitHub
 *                                  token, matches rows by githubId and refuses
 *                                  a row without githubId, so it never claims
 *                                  a legacy row
 */

/**
 * Whether a session is older than its user's cutoff. `authAt` is the mint time
 * the jwt callback stamps on the session. A user without a cutoff has no stale
 * session; once a cutoff exists, a session without a mint time counts as older
 * than it.
 */
export function isStaleSession(authAt: number | undefined, cutoff: Date | null | undefined): boolean {
  if (!cutoff) return false;
  return !(typeof authAt === "number" && authAt >= cutoff.getTime());
}

/**
 * Whether an API token was created at or before its user's cutoff, that is,
 * existed when the row was claimed and belongs to whoever held the row before.
 * The claim takes the cutoff after it holds the database write lock, so every
 * token committed before the claim has a `createdAt` below it, and the same
 * millisecond is refused too. A token a signed-in owner creates after the claim
 * is later than the cutoff.
 */
export function tokenPredatesCutoff(createdAt: Date, cutoff: Date | null | undefined): boolean {
  return !!cutoff && createdAt.getTime() <= cutoff.getTime();
}
