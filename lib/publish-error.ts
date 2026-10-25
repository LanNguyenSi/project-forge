import { scrubSecrets } from "@/lib/scrub-secrets";
import { internalErrorDetails } from "@/lib/server-error";

/**
 * Turn a raw publish failure message (git stderr from a failed push, or an
 * internal `github_<status>` / `repo_name_exists` code) into a short,
 * user-actionable reason safe to show a client.
 *
 * The full message is scrubbed of GitHub credentials (`lib/scrub-secrets.ts`)
 * and logged server-side. Known failures return a fixed sentence and are
 * logged without a reference id; anything else returns the same generic
 * sentence and reference id as `internalErrorDetails` (lib/server-error.ts)
 * and is logged under that same id, so git stderr, temp-dir paths and remote
 * URLs never reach clients.
 *
 * Cases are checked in this precedence order (a stderr can match more than
 * one; the first match wins, see the combined-input test):
 *   1. workflow scope    - the most specific and actionable push rejection.
 *   2. repo exists       - unambiguous create failure.
 *   3. rate limit        - GitHub also answers rate limiting with HTTP 403,
 *                          so this must precede the credentials case or the
 *                          403 substring would swallow it.
 *   4. credentials       - GitHub-specific auth rejections (github_401/403,
 *                          HTTP 401/403 and friends; never local failures).
 *   5. network           - transport failures, the least specific.
 *
 * Lives in lib/ rather than a route module because Next.js route files may
 * only export HTTP handlers and a fixed set of config fields.
 */
interface PublishErrorCase {
  pattern: RegExp;
  sentence: string;
}

const PUBLISH_ERROR_CASES: readonly PublishErrorCase[] = [
  {
    // GitHub's push-rejection hook text; the subject varies with the
    // credential type: "refusing to allow an OAuth App / a Personal Access
    // Token / a GitHub App to create or update workflow
    // `.github/workflows/ci.yml` without `workflow` scope" (all three are
    // supported credentials, see docs/api.md). Only the token-agnostic part
    // is matched, with a bounded window (no nested quantifiers) so a
    // crafted line cannot backtrack. The same stderr also carries generic
    // "[remote rejected]" / "failed to push" lines, so this most specific
    // phrase is checked first.
    pattern: /refusing to allow an? [^\n]{0,40}? to create or update workflow/i,
    sentence:
      "The GitHub token used for publishing lacks the workflow scope needed to create or update files under .github/workflows. Remove the workflow files from the project or grant the workflow scope, then publish again.",
  },
  {
    // v1's internal code for this failure, plus the two GitHub API texts
    // ("name already exists" as matched by the legacy route, and
    // "Repository 'owner/name' already exists"). Deliberately not a bare
    // "already exists": git's own "(already exists)" ref-rejection line
    // must not read as a taken repository name.
    pattern:
      /repo_name_exists|name already exists|repository '[^']*' already exists|repository already exists/i,
    sentence:
      "A repository with this name already exists on your GitHub account. Choose a different project name and publish again.",
  },
  {
    // "API rate limit exceeded for user ...", "You have exceeded a secondary
    // rate limit" and the abuse-detection variant of the same answer.
    pattern: /rate limit|abuse detection/i,
    sentence:
      "GitHub rate limited the publish request. Wait a few minutes and publish again.",
  },
  {
    // GitHub-specific auth rejections only: v1's github_401 / github_403
    // codes (line-anchored so a "github_403" substring inside a push blob
    // cannot read as a code), git's "The requested URL returned error:
    // 401/403" (the "returned error: " prefix is the digit guard, so counts,
    // port numbers or a UUID group like "-403a" cannot read as a status),
    // "fatal: Authentication failed", "remote: Invalid username or token /
    // password", the GitHub API "Bad credentials" body, and the push-time
    // "Permission to owner/repo.git denied to ..." line. Deliberately not a
    // bare "permission denied" or free-standing 401/403: fs EACCES, local
    // git config-lock errors, Postgres "permission denied for table" and
    // hex hashes or "at position 403" are local failures that must not be
    // blamed on GitHub credentials.
    pattern:
      /^(?:Error:\s*)?github_40[13]$|returned error: 40[13]\b|authentication failed|invalid username or (?:password|token)|bad credentials|Permission to \S+ denied/im,
    sentence:
      "GitHub rejected the credentials used for publishing. Reconnect GitHub in your account settings (the token may be expired or missing the repo scope) and publish again.",
  },
  {
    // curl-through-git transport failures: "Could not resolve host:
    // github.com", "Connection timed out", "Connection refused", "Failed to
    // connect to github.com port 443", "The remote end hung up
    // unexpectedly".
    pattern:
      /could not resolve host|connection timed out|connection refused|failed to connect|couldn.?t connect|network is unreachable|remote end hung up/i,
    sentence:
      "The server could not reach GitHub (network failure). Publish again in a few minutes.",
  },
];

/**
 * Summarize a publish failure for the client. `stderr` is the raw (not yet
 * scrubbed) error text from the publish flow; the caller never has to scrub
 * it. Known cases return a fixed sentence and are logged (scrubbed) without
 * a reference id; anything else returns the generic sentence with a
 * reference id and is logged under that same id, exactly as
 * internalErrorDetails does elsewhere.
 */
export function summarizePublishError(stderr: string): string {
  const scrubbed = scrubSecrets(stderr);
  const hit = PUBLISH_ERROR_CASES.find((c) => c.pattern.test(scrubbed));
  if (hit) {
    // The client gets a fixed sentence, so there is nothing for a reference
    // id to tie a response to; the full scrubbed message is logged for
    // diagnostics only.
    console.error("Publish failed:", scrubbed);
    return hit.sentence;
  }
  // Unrecognized failure: log it and answer with the generic sentence and
  // reference id, exactly as internalErrorDetails does elsewhere.
  return internalErrorDetails("Publish failed", new Error(scrubbed));
}
