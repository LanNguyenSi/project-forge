// Production start-up guard for values that ship as placeholders in the
// example files. It runs from instrumentation.ts. Next.js catches the error
// thrown from register(): the process keeps running and every request
// answers 500, so the container does not exit, but it never serves sessions
// signed with a publicly known value or sends logins to a callback URL that
// belongs to someone else, and its /api/health check fails. The first
// problem found is reported on its own (NEXTAUTH_SECRET is checked first).

// Placeholder values for NEXTAUTH_SECRET: .env.example
// ("your-secret-here-generate-with-openssl-rand-hex-32") and
// docker-compose.override.example.yml
// ("your_nextauth_secret_here-generate-with-openssl-rand-hex-32").
const PLACEHOLDER = /^your[-_]|generate-with-openssl/i;

// Placeholder host of NEXTAUTH_URL ("https://your-forge.example.com"), shipped
// in .env.example and docker-compose.override.example.yml. Only this exact
// host is refused: other your-* hosts are real hostnames.
const URL_PLACEHOLDER_HOST = "your-forge.example.com";

const URL_EXAMPLE = "the public URL of this instance, e.g. https://forge.example.com";

// Mirrors next-auth/utils/parse-url.js (v4): a value that does not start with
// "http" is prefixed with "https://", then parsed with new URL. Returns the
// hostname (already lowercased by URL), or undefined when NextAuth itself
// would throw.
function parseNextAuthHost(value: string): string | undefined {
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}

// Mirrors next-auth/utils/detect-origin.js (v4): without NEXTAUTH_URL, the
// origin is derived from the request when `VERCEL ?? AUTH_TRUST_HOST` is
// truthy (VERCEL, when set at all, wins even if empty).
function trustsRequestHost(env: Record<string, string | undefined>): boolean {
  return Boolean(env.VERCEL ?? env.AUTH_TRUST_HOST);
}

export function findSecretProblems(env: Record<string, string | undefined>): string[] {
  const secret = env.NEXTAUTH_SECRET?.trim();
  if (!secret) {
    return ["NEXTAUTH_SECRET is not set (generate one with: openssl rand -hex 32)"];
  }
  if (PLACEHOLDER.test(secret)) {
    return [
      "NEXTAUTH_SECRET is still the placeholder from the example files (generate one with: openssl rand -hex 32)",
    ];
  }
  const rawUrl = env.NEXTAUTH_URL;
  if (!rawUrl?.trim()) {
    if (trustsRequestHost(env)) {
      return [];
    }
    return [`NEXTAUTH_URL is not set (${URL_EXAMPLE}; or set AUTH_TRUST_HOST=true)`];
  }
  if (parseNextAuthHost(rawUrl) === undefined) {
    return [`NEXTAUTH_URL is not a valid URL (${URL_EXAMPLE})`];
  }
  // NextAuth's startsWith("http") is case-sensitive, so "HTTPS://your-forge..."
  // would parse there as host "https"; the placeholder is still caught by
  // reading the scheme case-insensitively.
  const lowerScheme = rawUrl.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase());
  if (parseNextAuthHost(lowerScheme) === URL_PLACEHOLDER_HOST) {
    return [`NEXTAUTH_URL is still the placeholder from the example files (${URL_EXAMPLE})`];
  }
  return [];
}

export function assertSecretsConfigured(env: Record<string, string | undefined>): void {
  const problems = findSecretProblems(env);
  if (problems.length > 0) {
    throw new Error(`Refusing to serve: ${problems.join("; ")}`);
  }
}
