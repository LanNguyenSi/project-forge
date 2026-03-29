import { describe, expect, it } from "vitest";
import { __internal } from "../../lib/post-scaffold-review";

describe("post-scaffold review helpers", () => {
  it("flags weak blueprint confidence as review-recommended", () => {
    const checks = __internal.buildDeterministicChecks(
      {
        blueprint: "rest-api",
        blueprintConfidence: "weak",
        agentMustCreateStructure: true,
      },
      {
        topLevelPaths: ["src"],
        samplePaths: ["src/main.py"],
      }
    );

    const verdict = __internal.summarizeDeterministicVerdict(checks);

    expect(checks.some((check) => check.status === "warn")).toBe(true);
    expect(verdict.status).toBe("review-recommended");
    expect(verdict.mustReviewBeforeImplementation).toBe(true);
  });

  it("flags missing scaffold input as mismatch", () => {
    const checks = __internal.buildDeterministicChecks(null, {
      topLevelPaths: [],
      samplePaths: [],
    });

    const verdict = __internal.summarizeDeterministicVerdict(checks);

    expect(checks[0]?.status).toBe("fail");
    expect(verdict.status).toBe("mismatch");
    expect(verdict.mustReviewBeforeImplementation).toBe(true);
  });

  it("maps implementation gate into scaffold fit preview", () => {
    const preview = __internal.toScaffoldFitPreview({
      version: "1.0",
      generatedBy: "project-forge",
      scaffoldInputPresent: true,
      scaffoldApplied: true,
      aiUsed: false,
      provider: null,
      model: null,
      blueprint: {
        selected: "rest-api",
        candidates: ["rest-api"],
        confidence: "weak",
        agentMustCreateStructure: true,
        reason: null,
        executionSummary: null,
        executionReason: null,
      },
      runtimeIndicators: {
        topLevelPaths: ["src"],
        samplePaths: ["src/main.py"],
      },
      checks: [],
      verdict: {
        status: "review-recommended",
        summary: "Treat scaffold as baseline only.",
        recommendedActions: ["Complete review before wave 1."],
        mustReviewBeforeImplementation: true,
      },
      followUpTask: {
        path: "tasks/900-blueprint-fit-review.md",
        title: "Review scaffold blueprint fit against the plan",
        mustCompleteBeforeWave: "wave-1",
      },
    });

    expect(preview?.mustReviewBeforeImplementation).toBe(true);
    expect(preview?.followUpTaskPath).toBe("tasks/900-blueprint-fit-review.md");
  });
});
