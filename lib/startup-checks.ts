// Production start-up guard for secrets that ship as placeholders in the
// example files. It runs from instrumentation.ts, so a container with a
// missing or copied-over secret exits at boot instead of serving sessions
// signed with a publicly known value.

// Placeholder values from .env.example and docker-compose.override.example.yml
// ("your-secret-here-generate-with-openssl-rand-hex-32",
// "your_nextauth_secret_here-generate-with-openssl-rand-hex-32").
const PLACEHOLDER = /^your[-_]|generate-with-openssl/i;

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
  return [];
}

export function assertSecretsConfigured(env: Record<string, string | undefined>): void {
  const problems = findSecretProblems(env);
  if (problems.length > 0) {
    throw new Error(`Refusing to start: ${problems.join("; ")}`);
  }
}
