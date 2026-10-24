import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route-level 500 bodies: a thrown error's text must not reach `details`;
 * the body carries the generic sentence with a reference id. The one
 * exception is the known GitHub failures of POST /api/v1/projects, which
 * keep their user-actionable text at the same status.
 */

const GENERIC = /^An internal error occurred\. Reference: [0-9a-f]{8}$/;
const THROWN = "prisma.secretTable.findMany() invalid at /srv/app/secret.ts ghp_leakedToken123";

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function expectGeneric(body: { ok: boolean; details?: string }) {
  expect(body.ok).toBe(false);
  expect(body.details).toMatch(GENERIC);
  expect(JSON.stringify(body)).not.toContain("secretTable");
  expect(JSON.stringify(body)).not.toContain("ghp_");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/ai-assist 500 body", () => {
  it("hides the provider error text", async () => {
    vi.doMock("@/lib/ai-provider", () => ({
      getAiCapabilities: () => ({
        enabled: true,
        provider: "local",
        model: "m",
        features: { magicFill: true, intakeEnrichment: true },
        maxContextChars: 50_000,
      }),
      generateStructuredJson: vi.fn(async () => {
        throw new Error(THROWN);
      }),
    }));
    const { POST } = await import("../../app/api/ai-assist/route");
    const res = await POST(jsonReq("http://test/api/ai-assist", { prompt: "a todo app" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("AI assist failed");
    expectGeneric(body);
  });
});

describe("POST /api/generate 500 body", () => {
  it("hides the pipeline error text", async () => {
    vi.doMock("next-auth", () => ({
      getServerSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
    }));
    vi.doMock("@/lib/auth", () => ({ authOptions: {} }));
    vi.doMock("@/lib/planforge-orchestrator", () => ({
      buildPlanforgeInput: vi.fn(async () => {
        throw new Error(THROWN);
      }),
    }));
    const { POST } = await import("@/app/api/generate/route");
    const res = await POST(
      jsonReq("http://test/api/generate", { projectName: "my-proj", summary: "Build something" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to generate project");
    expectGeneric(body);
  });
});

describe("POST /api/v1/projects 500 body", () => {
  function setup(opts: { orchestratorThrows?: boolean } = {}) {
    vi.doMock("@/lib/db", async () => {
      const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
      return {
        ...actual,
        prisma: { usageLog: { create: vi.fn() } },
        validateApiToken: vi.fn().mockResolvedValue({
          id: "tok-1",
          userId: "user-1",
          user: { id: "user-1", email: "u@example.com", githubPat: "ghp_userPat", githubOwner: "o", githubLogin: "o" },
        }),
        checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, used: 0 }),
      };
    });
    vi.doMock("@/lib/planforge-orchestrator", () => ({
      buildPlanforgeInput: opts.orchestratorThrows
        ? vi.fn(async () => {
            throw new Error(THROWN);
          })
        : vi.fn().mockResolvedValue({ planforgeInput: {} }),
    }));
    vi.doMock("@/lib/planforge-client", () => ({
      runPlanforgeViaHttp: vi.fn().mockResolvedValue({}),
      assertScaffoldkitRan: vi.fn(),
      PlanforgeClientError: class extends Error {},
    }));
    vi.doMock("@/lib/post-scaffold-review", () => ({ runPostScaffoldReview: vi.fn().mockResolvedValue({}) }));
    vi.stubEnv("PLANFORGE_URL", "http://planforge:8223");
    vi.stubEnv("PLANFORGE_SERVICE_TOKEN", "svc");
  }

  async function post() {
    const { POST } = await import("@/app/api/v1/projects/route");
    return POST(
      jsonReq("http://test/api/v1/projects", { projectName: "p", summary: "s" }, { "X-API-Key": "pf_test" }),
    );
  }

  function stubGithub(status: number, text: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(text, { status })),
    );
  }

  it("hides an unexpected pipeline error", async () => {
    setup({ orchestratorThrows: true });
    const res = await post();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Project generation failed");
    expectGeneric(body);
  });

  it("passes the invalid-PAT text through at 500", async () => {
    setup();
    stubGithub(401, "Bad credentials ghp_userPat");
    const res = await post();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.details).toMatch(/^Invalid or expired GitHub PAT/);
    expect(JSON.stringify(body)).not.toContain("Bad credentials");
  });

  it("passes the missing-permissions text through at 500", async () => {
    setup();
    stubGithub(403, "forbidden");
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).details).toMatch(/lacks required permissions/);
  });

  it("passes the name-exists text through at 500", async () => {
    setup();
    stubGithub(422, JSON.stringify({ message: "name already exists on this account" }));
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).details).toMatch(/A repository with this name already exists/);
  });

  it("scrubs a token inside the passed-through 422 message", async () => {
    setup();
    stubGithub(422, JSON.stringify({ message: "bad ghp_inGithubText1 value" }));
    const res = await post();
    const body = await res.json();
    expect(body.details).toContain("ghp_***");
    expect(body.details).not.toContain("inGithubText1");
  });

  it("answers an unknown GitHub failure generically, without the response text", async () => {
    setup();
    stubGithub(500, "upstream exploded ghp_userPat https://x-access-token:abc@github.com/o/r.git");
    const res = await post();
    expect(res.status).toBe(500);
    const body = await res.json();
    expectGeneric(body);
    expect(JSON.stringify(body)).not.toContain("exploded");
  });
});
