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

  it("forwards text-tier attachments into the enrichment user prompt", async () => {
    const generateMock = vi.fn(async () => ({
      provider: "local" as const,
      model: "qwen-local",
      data: { dataSensitivity: "regulated" as const },
    }));
    vi.doMock("@/lib/ai-provider", () => ({
      getAiCapabilities: () => ({
        enabled: true,
        provider: "local",
        model: "qwen-local",
        features: { magicFill: true, intakeEnrichment: true },
      }),
      generateStructuredJson: generateMock,
    }));

    const { buildPlanforgeInput } = await import("../../lib/planforge-orchestrator");

    await buildPlanforgeInput(
      {
        projectName: "demo-app",
        summary: "An internal portal.",
        features: ["dashboard"],
        constraints: [],
        targetUsers: ["staff"],
      },
      [
        {
          name: "arc42-snippet.md",
          mimeType: "text/markdown",
          tier: "text",
          inlineText: "## Compliance\n\nMust comply with HIPAA for patient data.",
        },
      ]
    );

    expect(generateMock).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt] = generateMock.mock.calls[0] as unknown as [string, string];

    // System prompt now instructs the model on additionalContext semantics.
    expect(systemPrompt).toMatch(/additionalContext/);
    expect(systemPrompt).toMatch(/arc42|RFC|charter/i);

    // User prompt carries the attachment under a stable key so the model
    // can latch onto it without prompt-position guessing.
    const parsed = JSON.parse(userPrompt) as Record<string, unknown>;
    expect(parsed).toHaveProperty("additionalContext");
    expect(parsed.additionalContext).toEqual([
      {
        name: "arc42-snippet.md",
        inlineText: "## Compliance\n\nMust comply with HIPAA for patient data.",
      },
    ]);
  });

  it("omits additionalContext from the user prompt when no attachments are present (back-compat)", async () => {
    const generateMock = vi.fn(async () => ({
      provider: "local" as const,
      model: "qwen-local",
      data: {},
    }));
    vi.doMock("@/lib/ai-provider", () => ({
      getAiCapabilities: () => ({
        enabled: true,
        provider: "local",
        model: "qwen-local",
        features: { magicFill: true, intakeEnrichment: true },
      }),
      generateStructuredJson: generateMock,
    }));

    const { buildPlanforgeInput } = await import("../../lib/planforge-orchestrator");

    await buildPlanforgeInput({
      projectName: "demo-app",
      summary: "An internal portal.",
      features: ["dashboard"],
      constraints: [],
      targetUsers: ["staff"],
    });

    const [, userPrompt] = generateMock.mock.calls[0] as unknown as [string, string];
    // Asserting absence (not just falsy) keeps the no-attachment user
    // prompt byte-identical to the pre-v0.1d shape — important if anyone
    // is caching prompt completions or pinning fixtures.
    const parsed = JSON.parse(userPrompt) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("additionalContext");
  });

  it("ignores diagram/structured tiers and empty inlineText in the prompt build", async () => {
    const generateMock = vi.fn(async () => ({
      provider: "local" as const,
      model: "qwen-local",
      data: {},
    }));
    vi.doMock("@/lib/ai-provider", () => ({
      getAiCapabilities: () => ({
        enabled: true,
        provider: "local",
        model: "qwen-local",
        features: { magicFill: true, intakeEnrichment: true },
      }),
      generateStructuredJson: generateMock,
    }));

    const { buildPlanforgeInput } = await import("../../lib/planforge-orchestrator");

    await buildPlanforgeInput(
      {
        projectName: "demo",
        summary: "x",
        features: ["a"],
        constraints: [],
        targetUsers: ["u"],
      },
      [
        // Diagram tier → no-op until v0.2.
        { name: "x.png", mimeType: "image/png", tier: "diagram" },
        // Structured tier → no-op until v0.2.
        { name: "x.drawio", mimeType: "application/vnd.jgraph.mxfile", tier: "structured" },
        // Text but empty → drop (no signal to add).
        { name: "empty.md", mimeType: "text/markdown", tier: "text", inlineText: "" },
        // Text but missing inlineText → drop.
        { name: "noinline.md", mimeType: "text/markdown", tier: "text" },
      ]
    );

    const [, userPrompt] = generateMock.mock.calls[0] as unknown as [string, string];
    const parsed = JSON.parse(userPrompt) as Record<string, unknown>;
    // None of the entries qualified, so additionalContext stays absent
    // — matches the back-compat path above.
    expect(parsed).not.toHaveProperty("additionalContext");
  });
});
