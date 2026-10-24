// Next.js calls register() once when the server starts. Only the production
// server is guarded: `next dev`, `next build` and the test runner are left
// alone so local development and CI do not need a real secret.
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { assertSecretsConfigured } = await import("./lib/startup-checks");
    assertSecretsConfigured(process.env);
  }
}
