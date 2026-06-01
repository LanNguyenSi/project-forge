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

  it("treats a manifest plus an empty src/ as NOT runtime-present (honest verdict)", () => {
    // The r4 over-claim: pyproject.toml is generated but src/ is an empty dir
    // with no source files, so collectRuntimePaths samples only the manifest.
    const checks = __internal.buildDeterministicChecks(
      { blueprint: "rest-api", blueprintConfidence: "strong", agentMustCreateStructure: false },
      { topLevelPaths: ["pyproject.toml", "src"], samplePaths: ["pyproject.toml"] }
    );

    const runtime = checks.find((check) => check.id === "runtime-structure-present");
    expect(runtime?.status).toBe("warn");

    const verdict = __internal.summarizeDeterministicVerdict(checks);
    expect(verdict.status).not.toBe("ok");
    expect(verdict.mustReviewBeforeImplementation).toBe(true);
  });

  it("treats a generated source file as runtime-present", () => {
    const checks = __internal.buildDeterministicChecks(
      { blueprint: "rest-api", blueprintConfidence: "strong", agentMustCreateStructure: false },
      { topLevelPaths: ["src"], samplePaths: ["src/index.ts"] }
    );

    const runtime = checks.find((check) => check.id === "runtime-structure-present");
    expect(runtime?.status).toBe("pass");

    const verdict = __internal.summarizeDeterministicVerdict(checks);
    expect(verdict.status).toBe("ok");
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

  it("warns on a manifest plus an empty src/ via the real on-disk sampler (no source code)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-forge-empty-scaffold-"));
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true }); // empty dir, no code
    await fs.writeFile(path.join(tempDir, "pyproject.toml"), '[project]\nname = "demo"\n');
    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify(
        {
          projectName: "demo",
          blueprint: "rest-api",
          blueprintConfidence: "strong",
          agentMustCreateStructure: false,
        },
        null,
        2
      )
    );

    const review = await runPostScaffoldReview(tempDir);

    // Even with a strong blueprint, an empty scaffold (manifest + empty src/,
    // no source file) must not be green-lit as runtime-present.
    const runtime = review.checks.find((check) => check.id === "runtime-structure-present");
    expect(runtime?.status).toBe("warn");
    expect(review.verdict.status).not.toBe("ok");
  });

  it("does not snapshot forge-internal bookkeeping (.forge-meta.json) as runtime structure", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-forge-forgemeta-"));
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "main.py"), "print('ok')\n");
    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify(
        {
          projectName: "demo",
          blueprint: "rest-api",
          blueprintConfidence: "strong",
          agentMustCreateStructure: false,
        },
        null,
        2
      )
    );
    // The two-phase generate->publish flow writes .forge-meta.json before the
    // review runs; publish removes it, so it must not be snapshotted as
    // deliverable runtime structure (that would advertise an absent path).
    await fs.writeFile(path.join(tempDir, ".forge-meta.json"), JSON.stringify({ owner: "u" }));

    await runPostScaffoldReview(tempDir);

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir, ".planforge", "post-scaffold-review.json"), "utf-8")
    );
    expect(persisted.runtimeIndicators.topLevelPaths).not.toContain(".forge-meta.json");
    // The filter is specific to bookkeeping: real source still registers.
    expect(persisted.runtimeIndicators.topLevelPaths).toContain("src");
  });
});

describe("post-scaffold review surfaces the blueprint-fit gate in the entry path", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  const AI_TASKS_FIXTURE = `# TASKS

## Critical Path

001 -> 002 -> 003

## wave-1

Lock scope, assumptions, and engineering baseline.

### 001 Write project charter and architecture baseline

- Priority: P0
- Category: foundation
- Depends on: none
- Summary: Capture scope.
`;

  const AGENTS_FIXTURE = `# AGENTS

## Build This Next

1. Read \`.planforge/docs/architecture-overview.md\` for the intended architecture.
2. Work the generated tasks in \`tasks/\` in dependency order (see \`.ai/TASKS.md\`).
3. Keep \`PROJECT.md\` and \`.ai/\` as the standing context.

## Important Files

- Machine-readable index: \`planforge-index.json\`
`;

  async function makeEntryRepo(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-forge-gate-"));
    tempDirs.push(tempDir);
    await fs.mkdir(path.join(tempDir, ".ai"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".ai", "TASKS.md"), AI_TASKS_FIXTURE);
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), AGENTS_FIXTURE);
    return tempDir;
  }

  it("prepends the gate to .ai/TASKS.md and AGENTS.md when surfaced", async () => {
    const tempDir = await makeEntryRepo();
    await __internal.surfaceBlueprintGateInEntryArtifacts(tempDir);

    const tasks = await fs.readFile(path.join(tempDir, ".ai", "TASKS.md"), "utf-8");
    expect(tasks).toContain("## Critical Path\n\n900 -> 001 -> 002 -> 003");
    expect(tasks).toContain("### 900 Review scaffold blueprint fit against the plan");
    // wave-0 sits before wave-1.
    expect(tasks.indexOf("## wave-0")).toBeGreaterThanOrEqual(0);
    expect(tasks.indexOf("## wave-0")).toBeLessThan(tasks.indexOf("## wave-1"));

    const agents = await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("tasks/900-blueprint-fit-review.md");
    // The gate callout sits under the Build This Next heading, before step 1.
    expect(agents.indexOf("Blocked: resolve")).toBeGreaterThanOrEqual(0);
    expect(agents.indexOf("Blocked: resolve")).toBeLessThan(agents.indexOf("1. Read"));
  });

  it("is idempotent (no double insert)", async () => {
    const tempDir = await makeEntryRepo();
    await __internal.surfaceBlueprintGateInEntryArtifacts(tempDir);
    const tasksOnce = await fs.readFile(path.join(tempDir, ".ai", "TASKS.md"), "utf-8");
    const agentsOnce = await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8");

    await __internal.surfaceBlueprintGateInEntryArtifacts(tempDir);
    const tasksTwice = await fs.readFile(path.join(tempDir, ".ai", "TASKS.md"), "utf-8");
    const agentsTwice = await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8");

    expect(tasksTwice).toBe(tasksOnce);
    expect(agentsTwice).toBe(agentsOnce);
    expect((tasksTwice.match(/## wave-0/g) || []).length).toBe(1);
    expect((agentsTwice.match(/Blocked: resolve/g) || []).length).toBe(1);
  });

  it("no-ops without throwing when the entry docs are absent", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-forge-gate-empty-"));
    tempDirs.push(tempDir);
    await expect(
      __internal.surfaceBlueprintGateInEntryArtifacts(tempDir)
    ).resolves.toBeUndefined();
  });

  it("runPostScaffoldReview surfaces the gate on a mismatch (weak confidence)", async () => {
    const tempDir = await makeEntryRepo();
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

    const review = await runPostScaffoldReview(tempDir);
    expect(review.verdict.mustReviewBeforeImplementation).toBe(true);

    const tasks = await fs.readFile(path.join(tempDir, ".ai", "TASKS.md"), "utf-8");
    const agents = await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8");
    expect(tasks).toContain("900 -> 001 -> 002 -> 003");
    expect(tasks).toContain("## wave-0");
    expect(agents).toContain("tasks/900-blueprint-fit-review.md");
  });

  it("runPostScaffoldReview leaves the entry docs untouched on an ok verdict", async () => {
    const tempDir = await makeEntryRepo();
    const tasksBefore = await fs.readFile(path.join(tempDir, ".ai", "TASKS.md"), "utf-8");
    const agentsBefore = await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8");

    // Strong blueprint + real source code => all checks pass => ok => no gate.
    await fs.writeFile(path.join(tempDir, "pyproject.toml"), '[project]\nname = "demo"\n');
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "main.py"), "def main():\n    return 0\n");
    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify(
        {
          projectName: "demo",
          blueprint: "rest-api",
          blueprintConfidence: "strong",
          agentMustCreateStructure: false,
        },
        null,
        2
      )
    );

    const review = await runPostScaffoldReview(tempDir);
    expect(review.verdict.status).toBe("ok");

    expect(await fs.readFile(path.join(tempDir, ".ai", "TASKS.md"), "utf-8")).toBe(
      tasksBefore
    );
    expect(await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8")).toBe(
      agentsBefore
    );
    await expect(
      fs.access(path.join(tempDir, "tasks", "900-blueprint-fit-review.md"))
    ).rejects.toThrow();
  });
});
