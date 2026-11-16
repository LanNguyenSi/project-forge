import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * The AI term of the worst-case sum next to RESERVATION_TTL_MS (lib/db.ts).
 * POST /api/v1/projects is the slowest publishing route, and between
 * reserveUsage() and its release it reaches generateStructuredJson()
 * (lib/ai-provider.ts, the client whose timeout and retries give the bound)
 * exactly AI_CALLS_ON_SLOWEST_ROUTE times: once inside buildPlanforgeInput
 * (intake enrichment) before the scaffold call, once in the post-scaffold
 * review after it.
 *
 * Only generateStructuredJson itself is replaced here: the route, the
 * orchestrator and the review are the real code, so the count is what the
 * route does, not what a stubbed step happens to skip. The margin of the sum
 * test cannot notice a count that is too low, so this is the pin that keeps
 * AI_CALLS_ON_SLOWEST_ROUTE honest: a route that gains or loses an AI call
 * fails here, and the constant, the sum and its comment have to follow.
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    validateApiToken: vi.fn(),
    reserveUsage: vi.fn(),
    confirmUsage: vi.fn(),
    releaseUsage: vi.fn(),
    prisma: { usageLog: { findMany: vi.fn(), count: vi.fn() } },
  };
});

vi.mock("@/lib/subprocess", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

// The planforge call is replaced by what its caller reads afterwards: the
// extracted scaffoldkit input in the session dir. Everything downstream of
// that, the post-scaffold review included, stays the real code.
vi.mock("@/lib/planforge-client", () => ({
  assertScaffoldkitRan: vi.fn(),
  PlanforgeClientError: class extends Error {},
  runPlanforgeViaHttp: vi.fn(async (options: { outdir: string }) => {
    const fsp = await import("fs/promises");
    const nodePath = await import("path");
    // What a real tarball leaves behind: the scaffoldkit input, a planned
    // tasks/ directory and at least one source file.
    await fsp.mkdir(nodePath.join(options.outdir, "tasks"), { recursive: true });
    await fsp.mkdir(nodePath.join(options.outdir, "src"), { recursive: true });
    await fsp.writeFile(nodePath.join(options.outdir, "src", "index.ts"), "export const demo = 1;\n");
    await fsp.writeFile(
      nodePath.join(options.outdir, "tasks", "001-demo.md"),
      "# Task 1: demo\n"
    );
    await fsp.writeFile(
      nodePath.join(options.outdir, "scaffoldkit-input.json"),
      JSON.stringify({
        projectName: "demo",
        summary: "A demo project",
        blueprint: "nextjs-app",
        blueprintConfidence: "strong",
        features: ["auth"],
      })
    );
    return {};
  }),
}));

// Real capabilities (they decide whether the two AI steps run at all), only
// the network call replaced.
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...actual,
    generateStructuredJson: vi.fn(async () => ({
      data: {},
      provider: "groq" as const,
      model: "test-model",
    })),
  };
});

import {
  validateApiToken,
  reserveUsage,
  confirmUsage,
  releaseUsage,
  AI_CALLS_ON_SLOWEST_ROUTE,
} from "@/lib/db";
import { generateStructuredJson } from "@/lib/ai-provider";

// The route reads FORGE_TEMP_DIR at module load, so the env is set before the
// route is imported (which is why the route comes in dynamically).
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pf-ai-call-count-"));
process.env.FORGE_TEMP_DIR = tempRoot;
const { POST: projectsPOST } = await import("@/app/api/v1/projects/route");

const mGenerate = vi.mocked(generateStructuredJson);

function post(body: unknown): NextRequest {
  return new NextRequest("http://test/api/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "pf_test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateApiToken).mockResolvedValue({
    id: "tok-1",
    userId: "user-1",
    revokedAt: null,
    user: {
      id: "user-1",
      email: "u@test.com",
      githubPat: "ghp_VALID_PAT_FOR_TESTS",
      githubOwner: "octo",
      githubLogin: "octo",
    },
  } as never);
  vi.mocked(reserveUsage).mockResolvedValue({ allowed: true, reservationId: "res-1" });
  vi.mocked(confirmUsage).mockResolvedValue(undefined);
  vi.mocked(releaseUsage).mockResolvedValue(undefined);
  // A configured provider is what turns intake enrichment and the
  // post-scaffold review on; the local branch comes first, so it is emptied.
  vi.stubEnv("LOCAL_AI_BASE_URL", "");
  vi.stubEnv("LOCAL_AI_MODEL", "");
  vi.stubEnv("GROQ_API_KEY", "gsk_test");
  vi.stubEnv("PLANFORGE_URL", "http://planforge:8223");
  vi.stubEnv("PLANFORGE_SERVICE_TOKEN", "svc");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          html_url: "https://github.com/octo/demo",
          clone_url: "https://github.com/octo/demo.git",
        }),
        { status: 201 }
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("POST /api/v1/projects: AI calls inside the reservation window", () => {
  it("makes exactly AI_CALLS_ON_SLOWEST_ROUTE generateStructuredJson() calls, the enrichment and the review", async () => {
    const res = await projectsPOST(post({ projectName: "demo", summary: "A demo project" }));
    const prompts = mGenerate.mock.calls.map((call) => String(call[0]));
    expect({ status: res.status, calls: prompts.length }).toEqual({
      status: 200,
      calls: AI_CALLS_ON_SLOWEST_ROUTE,
    });
    // Named so a new call site cannot hide behind the count alone: the two
    // calls are the intake enrichment and the post-scaffold review.
    expect(prompts.some((p) => /enrich project intake/.test(p))).toBe(true);
    expect(prompts.some((p) => /review whether a scaffold blueprint/.test(p))).toBe(true);
    expect(new Set(prompts).size).toBe(AI_CALLS_ON_SLOWEST_ROUTE);
  });
});
