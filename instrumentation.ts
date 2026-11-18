// Next.js calls register() once when the server starts. Only the production
// server is guarded: `next dev`, `next build` and the test runner are left
// alone so local development and CI do not need a real secret.
//
// After the checks pass, the production and the dev server start the one-off
// sweep that encrypts GitHub tokens still stored as plaintext
// (lib/github-pat.ts). It is not awaited, so the server serves while it runs,
// and a server that refuses to serve never reaches it. Not during `next build`,
// under the test runner (NODE_ENV=test), or on a dev server whose
// NEXTAUTH_SECRET or GITHUB_PAT_ENCRYPTION_KEY is missing or a placeholder.
//
// Everything sits inside the literal NEXT_RUNTIME === "nodejs" test so the
// edge bundle drops the imports (lib/github-pat.ts needs node:crypto and
// Prisma).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { assertStartupConfig, findKeyMaterialProblems } = await import("./lib/startup-checks");
    if (process.env.NODE_ENV === "production") {
      assertStartupConfig(process.env);
    }
    // The dev server is not refused, but it must not encrypt with a missing or
    // placeholder secret: the sweep waits until the key material is real.
    if (
      (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "development") &&
      findKeyMaterialProblems(process.env).length === 0
    ) {
      const { startLegacyGithubPatSweep } = await import("./lib/github-pat");
      startLegacyGithubPatSweep();
    }
  }
}
