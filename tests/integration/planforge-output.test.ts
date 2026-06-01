import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  readScaffoldPreview,
  resolvePlanforgeOutputPaths,
} from "../../lib/planforge-output";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "project-forge-planforge-"));
}

describe("planforge output resolver", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it("resolves paths from planforge-index.json when present", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, "planning"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "handoff"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "exports"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });

    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          version: "1.0",
          generatedBy: "agent-planforge",
          summary: "test",
          context: {
            plannerProfile: "product",
            phase: "phase_2",
            path: "core",
          },
          rootFiles: {
            agents: "AGENTS.md",
            claude: "CLAUDE.md",
            project: "PROJECT.md",
            charter: ".planforge/docs/project-charter.md",
            architecture: ".planforge/docs/architecture-overview.md",
            deliveryPlan: ".planforge/docs/delivery-plan.md",
            intakeQuestionnaire: ".planforge/docs/intake-questionnaire.md",
          },
          directories: {
            ai: ".ai",
            docs: ".planforge/docs",
            planning: "planning",
            handoff: "handoff",
            exports: "exports",
            prompts: "prompts",
            specs: "specs",
            adrs: "adrs",
            tasks: "tasks",
          },
          planning: {
            planOutput: "planning/plan-output.json",
            structuredInput: "planning/structured-input.json",
            rerunReport: "planning/rerun-report.json",
            rerunSummary: "planning/rerun-summary.md",
          },
          handoff: {
            manifest: "handoff/manifest.json",
            runnerContract: "handoff/runner-contract.json",
            runnerDirectory: "handoff/runner",
          },
          exports: {
            scaffoldkit: "exports/scaffoldkit-input.json",
            devreview: "exports/devreview.json",
          },
          ai: {
            agents: ".ai/AGENTS.md",
            architecture: ".ai/ARCHITECTURE.md",
            tasks: ".ai/TASKS.md",
            decisions: ".ai/DECISIONS.md",
          },
        },
        null,
        2
      )
    );

    const resolved = await resolvePlanforgeOutputPaths(tempDir);

    expect(resolved.hasIndex).toBe(true);
    expect(resolved.indexPath).toBe(path.join(tempDir, "planforge-index.json"));
    expect(resolved.architecturePath).toBe(
      path.join(tempDir, ".planforge", "docs", "architecture-overview.md")
    );
    expect(resolved.scaffoldkitInputPath).toBe(
      path.join(tempDir, "exports", "scaffoldkit-input.json")
    );
    expect(resolved.planOutputPath).toBe(
      path.join(tempDir, "planning", "plan-output.json")
    );
  });

  it("falls back to legacy root paths when no index is present", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    const resolved = await resolvePlanforgeOutputPaths(tempDir);

    expect(resolved.hasIndex).toBe(false);
    expect(resolved.scaffoldkitInputPath).toBe(
      path.join(tempDir, "scaffoldkit-input.json")
    );
    expect(resolved.planOutputPath).toBe(path.join(tempDir, "plan-output.json"));
  });

  it("reads scaffold preview from the indexed exports path", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, "exports"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          version: "1.0",
          generatedBy: "agent-planforge",
          summary: "test",
          context: {
            plannerProfile: "product",
            phase: "phase_2",
            path: "core",
          },
          rootFiles: {
            agents: "AGENTS.md",
            claude: "CLAUDE.md",
            project: "PROJECT.md",
            charter: ".planforge/docs/project-charter.md",
            architecture: ".planforge/docs/architecture-overview.md",
            deliveryPlan: ".planforge/docs/delivery-plan.md",
            intakeQuestionnaire: ".planforge/docs/intake-questionnaire.md",
          },
          directories: {
            ai: ".ai",
            docs: ".planforge/docs",
            planning: "planning",
            handoff: "handoff",
            exports: "exports",
            prompts: "prompts",
            specs: "specs",
            adrs: "adrs",
            tasks: "tasks",
          },
          planning: {
            planOutput: "planning/plan-output.json",
            structuredInput: "planning/structured-input.json",
            rerunReport: "planning/rerun-report.json",
            rerunSummary: "planning/rerun-summary.md",
          },
          handoff: {
            manifest: "handoff/manifest.json",
            runnerContract: "handoff/runner-contract.json",
            runnerDirectory: "handoff/runner",
          },
          exports: {
            scaffoldkit: "exports/scaffoldkit-input.json",
            devreview: "exports/devreview.json",
          },
          ai: {
            agents: ".ai/AGENTS.md",
            architecture: ".ai/ARCHITECTURE.md",
            tasks: ".ai/TASKS.md",
            decisions: ".ai/DECISIONS.md",
          },
        },
        null,
        2
      )
    );

    await fs.writeFile(
      path.join(tempDir, "exports", "scaffoldkit-input.json"),
      JSON.stringify({ blueprintConfidence: "weak" }, null, 2)
    );

    const preview = await readScaffoldPreview(tempDir);

    expect(preview.status).toBe("planning-baseline");
  });

  it("treats an index without a handoff block as valid (post-Phase-3 layout)", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, ".planforge", "exports"), { recursive: true });
    // No handoff block, exports/plan-output relocated under .planforge/ — the
    // shape agent-planforge emits once the runner/handoff vision is removed.
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          version: "2.0",
          generatedBy: "agent-planforge",
          rootFiles: {
            agents: "AGENTS.md",
            architecture: ".planforge/docs/architecture-overview.md",
          },
          directories: { ai: ".ai", tasks: "tasks" },
          planning: { planOutput: ".planforge/planning/plan-output.json" },
          exports: { scaffoldkit: ".planforge/exports/scaffoldkit-input.json" },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    const resolved = await resolvePlanforgeOutputPaths(tempDir);

    // The missing handoff block must NOT invalidate the index and silently
    // fall back to flat-layout defaults (which would mis-resolve scaffoldkit
    // input and degrade every scaffold-fit check to PLANNING_BASELINE).
    expect(resolved.hasIndex).toBe(true);
    expect(resolved.scaffoldkitInputPath).toBe(
      path.join(tempDir, ".planforge", "exports", "scaffoldkit-input.json")
    );
    expect(resolved.planOutputPath).toBe(
      path.join(tempDir, ".planforge", "planning", "plan-output.json")
    );
  });

  it("rejects an index whose handoff block is present but malformed", async () => {
    // The optional-handoff branch must tolerate an ABSENT handoff only — a
    // present-but-broken handoff still invalidates the whole index (otherwise a
    // malformed block would slip through as valid).
    const malformedHandoffs: unknown[] = ["not-a-map", { manifest: "" }, { manifest: 123 }];

    for (const handoff of malformedHandoffs) {
      const tempDir = await makeTempDir();
      tempDirs.push(tempDir);

      await fs.writeFile(
        path.join(tempDir, "planforge-index.json"),
        JSON.stringify(
          {
            generatedBy: "agent-planforge",
            rootFiles: { agents: "AGENTS.md", architecture: "architecture-overview.md" },
            directories: { ai: ".ai", tasks: "tasks" },
            planning: { planOutput: "planning/plan-output.json" },
            handoff,
            exports: { scaffoldkit: "exports/scaffoldkit-input.json" },
            ai: { agents: ".ai/AGENTS.md" },
          },
          null,
          2
        )
      );

      const resolved = await resolvePlanforgeOutputPaths(tempDir);

      expect(resolved.hasIndex).toBe(false);
    }
  });
});
