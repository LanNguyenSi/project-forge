const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * Whether GitHub reports `email` as a verified address of the account that
 * owns `accessToken` (`GET /user/emails`, needs the `user:email` scope).
 *
 * Any verified address counts, primary or not: what matters is that the
 * account holder proved they control it, and a verified secondary address
 * proves that as well as the primary one. The comparison ignores case.
 *
 * Fails closed: a missing token, a network error, a timeout, a non-200
 * answer, a body that is not a list, or no matching verified entry all give
 * `false`. The token and the response body are never logged or returned; the
 * only thing logged is the HTTP status of a failed lookup.
 */
export async function isGithubEmailVerified(
  accessToken: string | undefined,
  email: string,
): Promise<boolean> {
  if (!accessToken || !email) return false;
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
    return false;
  }
  if (response.status !== 200) {
    console.warn(`GitHub email verification failed: HTTP ${response.status}`);
    return false;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.warn("GitHub email verification failed: unreadable response");
    return false;
  }
  if (!Array.isArray(body)) return false;
  const wanted = email.toLowerCase();
  return body.some((entry) => {
    const item = entry as { email?: unknown; verified?: unknown } | null;
    return (
      typeof item?.email === "string" &&
      item.email.toLowerCase() === wanted &&
      item.verified === true
    );
  });
}
