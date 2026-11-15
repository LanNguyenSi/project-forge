const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * What GitHub says about an email address of a signed-in account:
 *  - `verified`: `GET /user/emails` lists the address with `verified: true`;
 *  - `unverified`: GitHub answered and the address is not listed as verified
 *    (not listed at all, or listed with `verified` other than `true`);
 *  - `unknown`: GitHub could not be asked or did not give a usable answer (no
 *    token, network error, timeout, any status but 200, a body that is not
 *    JSON or not a list). A retry may give another result.
 */
export type GithubEmailStatus = "verified" | "unverified" | "unknown";

/**
 * Looks `email` up in the address list of the account that owns `accessToken`
 * (`GET /user/emails`, needs the `user:email` scope).
 *
 * Any verified address counts, primary or not: what matters is that the
 * account holder proved they control it, and a verified secondary address
 * proves that as well as the primary one. The comparison ignores case on both
 * sides.
 *
 * The token and the response body are never logged or returned; the only
 * thing logged is a fixed message and, for a non-200 answer, its HTTP status.
 */
export async function githubEmailStatus(
  accessToken: string | undefined,
  email: string,
): Promise<GithubEmailStatus> {
  if (!accessToken || !email) return "unknown";
  let response: Response;
  try {
    response = await fetch(GITHUB_EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "project-forge",
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    console.warn("GitHub email verification failed: request did not complete");
    return "unknown";
  }
  if (response.status !== 200) {
    console.warn(`GitHub email verification failed: HTTP ${response.status}`);
    return "unknown";
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.warn("GitHub email verification failed: unreadable response");
    return "unknown";
  }
  if (!Array.isArray(body)) {
    console.warn("GitHub email verification failed: unexpected response");
    return "unknown";
  }
  const wanted = email.toLowerCase();
  const verified = body.some((entry) => {
    const item = entry as { email?: unknown; verified?: unknown } | null;
    return (
      typeof item?.email === "string" &&
      item.email.toLowerCase() === wanted &&
      item.verified === true
    );
  });
  return verified ? "verified" : "unverified";
}
