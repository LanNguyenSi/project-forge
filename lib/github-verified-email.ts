const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const LOOKUP_TIMEOUT_MS = 5000;

type EmailEntry = { email?: unknown; verified?: unknown; primary?: unknown };

/**
 * Fetches the address list of the account that owns `accessToken`
 * (`GET /user/emails`, needs the `user:email` scope). Returns the list, or
 * `null` when GitHub could not be asked or gave no usable answer: no token,
 * network error, timeout, any status but 200, a body that is not JSON or not a
 * list. A retry may give another result.
 *
 * The token and the response body are never logged or returned; the only
 * thing logged is a fixed message and, for a non-200 answer, its HTTP status.
 */
async function fetchEmailList(accessToken: string | undefined): Promise<EmailEntry[] | null> {
  if (!accessToken) return null;
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
    return null;
  }
  if (response.status !== 200) {
    console.warn(`GitHub email verification failed: HTTP ${response.status}`);
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.warn("GitHub email verification failed: unreadable response");
    return null;
  }
  if (!Array.isArray(body)) {
    console.warn("GitHub email verification failed: unexpected response");
    return null;
  }
  return body.map((entry) => (entry && typeof entry === "object" ? (entry as EmailEntry) : {}));
}

/**
 * What GitHub says about an email address of a signed-in account:
 *  - `verified`: the address is listed with `verified: true`;
 *  - `unverified`: GitHub answered and the address is not listed as verified
 *    (not listed at all, or listed with `verified` other than `true`);
 *  - `unknown`: GitHub could not be asked or gave no usable answer.
 */
export type GithubEmailStatus = "verified" | "unverified" | "unknown";

/**
 * Looks `email` up in the account's address list.
 *
 * Any verified address counts, primary or not: what matters is that the
 * account holder proved they control it, and a verified secondary address
 * proves that as well as the primary one. The comparison ignores case on both
 * sides.
 */
export async function githubEmailStatus(
  accessToken: string | undefined,
  email: string,
): Promise<GithubEmailStatus> {
  if (!email) return "unknown";
  const list = await fetchEmailList(accessToken);
  if (!list) return "unknown";
  const wanted = email.toLowerCase();
  const verified = list.some(
    (item) =>
      typeof item.email === "string" && item.email.toLowerCase() === wanted && item.verified === true,
  );
  return verified ? "verified" : "unverified";
}

/**
 * The account's own primary address, for a sign-in where the provider
 * reported no email (its own `/user/emails` call may have failed):
 *  - `found`: an address listed with `primary: true` and `verified: true`
 *    (the primary one only; a verified secondary address is not picked,
 *    because choosing among several would be a guess);
 *  - `none`: GitHub answered and the account has no verified primary address;
 *  - `unknown`: GitHub could not be asked or gave no usable answer.
 */
export type GithubPrimaryEmail =
  | { status: "found"; email: string }
  | { status: "none" }
  | { status: "unknown" };

export async function githubPrimaryVerifiedEmail(
  accessToken: string | undefined,
): Promise<GithubPrimaryEmail> {
  const list = await fetchEmailList(accessToken);
  if (!list) return { status: "unknown" };
  const primary = list.find(
    (item) => typeof item.email === "string" && item.email && item.primary === true && item.verified === true,
  );
  return primary ? { status: "found", email: primary.email as string } : { status: "none" };
}

/**
 * The email a new or claimed row is keyed on, or null when GitHub could not be
 * asked. Every row that is created or claimed goes through this: a non-null
 * result is an address GitHub lists as verified for the account, or the
 * placeholder, and the placeholder is returned only after GitHub gave a
 * definite answer (the reported address is not verified, or the account has no
 * verified primary address). An inconclusive lookup is always null.
 */
export async function resolveGithubEmail(
  reported: string | null | undefined,
  accessToken: string | undefined,
  placeholder: string,
): Promise<string | null> {
  if (reported) {
    const status = await githubEmailStatus(accessToken, reported);
    if (status === "unknown") return null;
    return status === "verified" ? reported : placeholder;
  }
  const primary = await githubPrimaryVerifiedEmail(accessToken);
  if (primary.status === "unknown") return null;
  return primary.status === "found" ? primary.email : placeholder;
}
