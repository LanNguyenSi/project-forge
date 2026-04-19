/**
 * Minimal GitHub API helper.
 *
 * Used by the identity-broker registration endpoint to verify an access-token
 * actually belongs to the claimed user. Deliberately thin — we only need the
 * `/user` endpoint and we want to classify failure modes (invalid token vs
 * upstream unreachable) so the broker can distinguish "re-auth required"
 * from "retry in a moment".
 */

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class GitHubUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubUnreachableError";
  }
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
  } catch (err) {
    throw new GitHubUnreachableError(
      `Could not reach GitHub: ${(err as Error).message}`,
    );
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GitHubAuthError(
      `GitHub rejected the access-token (${response.status})`,
    );
  }
  if (!response.ok) {
    // 5xx or other transient — tell the caller to retry.
    throw new GitHubUnreachableError(
      `GitHub API returned ${response.status}`,
    );
  }

  return response.json() as Promise<GitHubUser>;
}
