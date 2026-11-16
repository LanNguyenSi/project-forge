/**
 * Whether a session is older than its user's cutoff (User.sessionsValidAfter,
 * set when a legacy GitHub-only row is claimed, see signInWithGithub in
 * lib/auth.ts). `authAt` is the mint time the jwt callback stamps on the
 * session. A user without a cutoff has no stale session; once a cutoff exists, a
 * session without a mint time counts as older than it.
 *
 * getServerSession already refuses a stale session, but the row can be claimed
 * after that check. A route that hands out or overwrites a credential reads the
 * cutoff together with the data it uses (or in the write itself) and applies
 * this to that value, so the decision and the use see one state of the row.
 */
export function isStaleSession(authAt: number | undefined, cutoff: Date | null | undefined): boolean {
  if (!cutoff) return false;
  return !(typeof authAt === "number" && authAt >= cutoff.getTime());
}
