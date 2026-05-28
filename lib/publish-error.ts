/**
 * Turn a raw (PAT-sanitized) publish failure message into a short, user-facing
 * reason. Maps the known createAndPushRepo error codes; otherwise surfaces the
 * most telling line of git's captured stderr (e.g. a "remote rejected" push
 * error such as a missing `workflow` OAuth scope).
 *
 * Lives in lib/ rather than the route module because Next.js route files may
 * only export HTTP handlers and a fixed set of config fields.
 */
export function summarizePublishError(sanitized: string): string {
  // The createAndPushRepo codes are thrown as the *entire* error message
  // ("repo_name_exists" / "github_422"). Anchor on that so a 3-digit run
  // inside a multi-line git-push stderr blob can't be misread as an HTTP code.
  const trimmed = sanitized.trim();
  if (/^(?:Error:\s*)?repo_name_exists$/.test(trimmed)) {
    return "a repository with that name already exists on your GitHub account";
  }
  const ghMatch = trimmed.match(/^(?:Error:\s*)?github_(\d{3})$/);
  if (ghMatch) return `GitHub rejected the request (HTTP ${ghMatch[1]})`;

  const lines = sanitized.split("\n").map((l) => l.trim()).filter(Boolean);
  const telling = lines.find((l) => /\[remote rejected\]|^remote:|^error:|refusing to/i.test(l));
  if (telling) return telling.replace(/^remote:\s*/i, "").slice(0, 300);

  return (lines[lines.length - 1] ?? "unknown error").slice(0, 300);
}
