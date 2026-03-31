import { afterEach, describe, expect, it, vi } from "vitest";

describe("planforge intake orchestration", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.LOCAL_AI_BASE_URL;
    delete process.env.LOCAL_AI_MODEL;
    delete process.env.LOCAL_AI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("uses deterministic mapping when no AI provider is configured", async () => {
    const { buildPlanforgeInput } = await import("../../lib/planforge-orchestrator");

    const result = await buildPlanforgeInput({
      projectName: "demo-app",
      summary: "An internal dashboard.",
      features: [],
      constraints: ["TypeScript only"],
      targetUsers: [],
    });

    expect(result.orchestration.mode).toBe("deterministic");
    expect(result.planforgeInput.coreFeatures).toEqual(["core functionality"]);
    expect(result.planforgeInput.targetUsers).toEqual(["developers"]);
    expect(result.planforgeInput.constraints).toEqual(["TypeScript only"]);
  });

  it("merges optional AI enrichment when a provider is available", async () => {
    vi.doMock("@/lib/ai-provider", () => ({
      getAiCapabilities: () => ({
        enabled: true,
        provider: "local",
        model: "qwen-local",
        features: {
          magicFill: true,
          intakeEnrichment: true,
        },
      }),
      generateStructuredJson: vi.fn(async () => ({
        provider: "local",
        model: "qwen-local",
        data: {
          plannerProfile: "platform",
          integrations: ["GitHub API"],
          openQuestions: ["Should the first release support SSO?"],
        },
      })),
    }));

    const { buildPlanforgeInput } = await import("../../lib/planforge-orchestrator");

    const result = await buildPlanforgeInput({
      projectName: "demo-app",
      summary: "A platform control plane.",
      features: ["Provision environments"],
      constraints: [],
      targetUsers: ["platform team"],
    });

    expect(result.orchestration.mode).toBe("ai-enriched");
    expect(result.orchestration.aiUsed).toBe(true);
    expect(result.planforgeInput.plannerProfile).toBe("platform");
    expect(result.planforgeInput.integrations).toEqual(["GitHub API"]);
    expect(result.planforgeInput.openQuestions).toEqual([
      "Should the first release support SSO?",
    ]);
  });
});
