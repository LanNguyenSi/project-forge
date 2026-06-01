import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  __internal,
  readPostScaffoldReview,
  runPostScaffoldReview,
} from "../../lib/post-scaffold-review";

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

describe("post-scaffold review artifact relocation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it("writes the review under .planforge/ and reads it back (no handoff/ dependency)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-forge-review-"));
    tempDirs.push(tempDir);

    // tasks/ always exists in a real planforge output tree; the weak-confidence
    // path writes a tasks/900 follow-up into it.
    await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });

    // Flat-layout scaffoldkit input (no index): resolvePlanforgeOutputPaths
    // falls back to <tempDir>/scaffoldkit-input.json.
    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify(
        {
          projectName: "demo",
          blueprint: "rest-api",
          blueprintConfidence: "weak",
          agentMustCreateStructure: true,
        },
        null,
        2
      )
    );

    const written = await runPostScaffoldReview(tempDir);

    // Artifacts land under .planforge/, not the (removed) handoff/ dir.
    await expect(
      fs.access(path.join(tempDir, ".planforge", "post-scaffold-review.json"))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempDir, ".planforge", "post-scaffold-review.md"))
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempDir, "handoff", "post-scaffold-review.json"))
    ).rejects.toThrow();

    // Round-trip: the sole reader resolves the same .planforge/ location.
    const readBack = await readPostScaffoldReview(tempDir);
    expect(readBack).not.toBeNull();
    expect(readBack?.verdict.status).toBe(written.verdict.status);
    expect(readBack?.blueprint.selected).toBe("rest-api");
  });
});
