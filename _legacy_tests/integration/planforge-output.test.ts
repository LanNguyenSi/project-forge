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
            charter: "project-charter.md",
            architecture: "architecture-overview.md",
            deliveryPlan: "delivery-plan.md",
            intakeQuestionnaire: "intake-questionnaire.md",
          },
          directories: {
            ai: ".ai",
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
    expect(resolved.scaffoldkitInputPath).toBe(
      path.join(tempDir, "exports", "scaffoldkit-input.json")
    );
    expect(resolved.planOutputPath).toBe(
      path.join(tempDir, "planning", "plan-output.json")
    );
    expect(resolved.handoffManifestPath).toBe(
      path.join(tempDir, "handoff", "manifest.json")
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
    expect(resolved.handoffManifestPath).toBe(
      path.join(tempDir, "handoff-manifest.json")
    );
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
            charter: "project-charter.md",
            architecture: "architecture-overview.md",
            deliveryPlan: "delivery-plan.md",
            intakeQuestionnaire: "intake-questionnaire.md",
          },
          directories: {
            ai: ".ai",
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
});
