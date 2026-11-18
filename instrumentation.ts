// Next.js calls register() once when the server starts. Only the production
// server is guarded: `next dev`, `next build` and the test runner are left
// alone so local development and CI do not need a real secret.
//
// After the checks pass, the production and the dev server start the one-off
// sweep that encrypts GitHub tokens still stored as plaintext
// (lib/github-pat.ts). It is not awaited, so the server serves while it runs,
// and a server that refuses to serve never reaches it. Not during `next build`
// or under the test runner (NODE_ENV=test).
//
// Everything sits inside the literal NEXT_RUNTIME === "nodejs" test so the
// edge bundle drops the imports (lib/github-pat.ts needs node:crypto and
// Prisma).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    if (process.env.NODE_ENV === "production") {
      const { assertStartupConfig } = await import("./lib/startup-checks");
      assertStartupConfig(process.env);
    }
    if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "development") {
      const { startLegacyGithubPatSweep } = await import("./lib/github-pat");
      startLegacyGithubPatSweep();
    }
  }
}
