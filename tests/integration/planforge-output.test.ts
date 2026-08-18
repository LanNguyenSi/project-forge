import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  excludePlanforgeArtifactsFromPublish,
  prunePublishedPlanforgeIndex,
  readScaffoldPreview,
  resolvePlanforgeOutputPaths,
} from "../../lib/planforge-output";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "project-forge-planforge-"));
}

describe("planforge publish exclusion", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it("keeps generation-only artifacts out of git while staging the rest", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, "planning"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "exports"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "planning", "plan-output.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "exports", "scaffoldkit-input.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "planning", "structured-input.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "planning", "rerun-report.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "planning", "rerun-summary.md"), "# rerun\n");
    await fs.writeFile(path.join(tempDir, "README.md"), "# demo\n");

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: tempDir, stdio: "pipe" });
    git(["init"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);

    await excludePlanforgeArtifactsFromPublish(tempDir);
    git(["add", "-A"]);

    const staged = execFileSync("git", ["ls-files"], {
      cwd: tempDir,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);

    // The whole planning/ directory is generation-only state, not just
    // plan-output.json: structured-input.json + rerun-report.json +
    // rerun-summary.md are kept out of the deliverable too.
    expect(staged).not.toContain("planning/plan-output.json");
    expect(staged).not.toContain("exports/scaffoldkit-input.json");
    expect(staged).not.toContain("planning/structured-input.json");
    expect(staged).not.toContain("planning/rerun-report.json");
    expect(staged).not.toContain("planning/rerun-summary.md");
    // Deliverable files outside planning/ are still committed.
    expect(staged).toContain("README.md");
  });

  it("derives exclude paths from the index when artifacts are relocated", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    // A future .planforge/-relocated layout: the exclude must follow the index,
    // not hardcoded paths, or the artifacts silently leak back in.
    await fs.mkdir(path.join(tempDir, ".planforge", "planning"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".planforge", "exports"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".planforge", "planning", "plan-output.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, ".planforge", "planning", "structured-input.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, ".planforge", "exports", "scaffoldkit-input.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "README.md"), "# demo\n");
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          generatedBy: "agent-planforge",
          rootFiles: { agents: "AGENTS.md" },
          directories: { ai: ".ai", tasks: "tasks" },
          planning: { planOutput: ".planforge/planning/plan-output.json" },
          exports: { scaffoldkit: ".planforge/exports/scaffoldkit-input.json" },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: tempDir, stdio: "pipe" });
    git(["init"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);

    await excludePlanforgeArtifactsFromPublish(tempDir);
    git(["add", "-A"]);

    const staged = execFileSync("git", ["ls-files"], {
      cwd: tempDir,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);

    // The exclude follows the index-derived planning directory, so every
    // planning artifact under .planforge/planning/ is kept out, not just
    // plan-output.json.
    expect(staged).not.toContain(".planforge/planning/plan-output.json");
    expect(staged).not.toContain(".planforge/planning/structured-input.json");
    expect(staged).not.toContain(".planforge/exports/scaffoldkit-input.json");
    expect(staged).toContain("README.md");
    expect(staged).toContain("planforge-index.json");
  });

  it("prunes excluded planning/exports entries from the shipped index, keeps the rest", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.mkdir(path.join(tempDir, "planning"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "exports"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "planning", "plan-output.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "exports", "scaffoldkit-input.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "exports", "devreview.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "README.md"), "# demo\n");
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          generatedBy: "agent-planforge",
          summary: "keep me",
          rootFiles: { agents: "AGENTS.md" },
          directories: { ai: ".ai", planning: "planning", exports: "exports", tasks: "tasks" },
          planning: {
            planOutput: "planning/plan-output.json",
            structuredInput: "planning/structured-input.json",
          },
          exports: { scaffoldkit: "exports/scaffoldkit-input.json", devreview: "exports/devreview.json" },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: tempDir, stdio: "pipe" });
    git(["init"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);

    // Order is load-bearing: exclude reads the complete index, prune rewrites it after.
    await excludePlanforgeArtifactsFromPublish(tempDir);
    await prunePublishedPlanforgeIndex(tempDir);
    git(["add", "-A"]);

    const shipped = JSON.parse(
      await fs.readFile(path.join(tempDir, "planforge-index.json"), "utf-8")
    );

    // Excluded entries are gone from the shipped index.
    expect(shipped.planning).toEqual({});
    expect(shipped.directories.planning).toBeUndefined();
    expect(shipped.exports.scaffoldkit).toBeUndefined();
    // A still-shipping export (devreview ships, so its dir entry stays) is kept.
    expect(shipped.exports.devreview).toBe("exports/devreview.json");
    expect(shipped.directories.exports).toBe("exports");
    // Unrelated fields and other directories are preserved.
    expect(shipped.summary).toBe("keep me");
    expect(shipped.rootFiles.agents).toBe("AGENTS.md");
    expect(shipped.directories.tasks).toBe("tasks");

    const staged = execFileSync("git", ["ls-files"], { cwd: tempDir, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    expect(staged).toContain("planforge-index.json");
    expect(staged).toContain("exports/devreview.json");
    expect(staged).not.toContain("planning/plan-output.json");
    expect(staged).not.toContain("exports/scaffoldkit-input.json");
  });

  it("drops directories.exports from the shipped index when scaffoldkit-input was the only export", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          generatedBy: "agent-planforge",
          rootFiles: { agents: "AGENTS.md" },
          directories: { ai: ".ai", planning: "planning", exports: "exports" },
          planning: { planOutput: "planning/plan-output.json" },
          exports: { scaffoldkit: "exports/scaffoldkit-input.json" },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    await prunePublishedPlanforgeIndex(tempDir);

    const shipped = JSON.parse(
      await fs.readFile(path.join(tempDir, "planforge-index.json"), "utf-8")
    );
    expect(shipped.exports).toEqual({});
    expect(shipped.directories.exports).toBeUndefined();
    expect(shipped.directories.planning).toBeUndefined();
    expect(shipped.directories.ai).toBe(".ai");
    expect(shipped.planning).toEqual({});
  });

  it("never emits a root exclude for a flat-layout index (root-guard)", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    // Degenerate flat layout: planning artifacts sit at the repo root, so the
    // planning directory resolves to the repo root. The guard must fall back to
    // excluding the single plan-output.json file, never a bare "/" that would
    // drop the whole deliverable.
    await fs.writeFile(path.join(tempDir, "plan-output.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "scaffoldkit-input.json"), "{}\n");
    await fs.writeFile(path.join(tempDir, "README.md"), "# demo\n");
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          generatedBy: "agent-planforge",
          rootFiles: { agents: "AGENTS.md" },
          directories: { ai: ".ai", tasks: "tasks" },
          planning: { planOutput: "plan-output.json" },
          exports: { scaffoldkit: "scaffoldkit-input.json" },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: tempDir, stdio: "pipe" });
    git(["init"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);

    await excludePlanforgeArtifactsFromPublish(tempDir);

    const excludeLines = (
      await fs.readFile(path.join(tempDir, ".git", "info", "exclude"), "utf-8")
    )
      .split("\n")
      .map((line) => line.trim());
    expect(excludeLines).not.toContain("/");

    git(["add", "-A"]);
    const staged = execFileSync("git", ["ls-files"], {
      cwd: tempDir,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);

    expect(staged).toContain("README.md");
    expect(staged).toContain("planforge-index.json");
    expect(staged).not.toContain("plan-output.json");
    expect(staged).not.toContain("scaffoldkit-input.json");
  });
});

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

  it("labels a strong-confidence scaffold that emitted no source as planning baseline, not full", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    // Strong confidence and the agent need not create structure, but the scaffold
    // wrote no real source file (only the planforge input manifest). The label
    // must not overclaim "full scaffold".
    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify({ blueprintConfidence: "strong", agentMustCreateStructure: false }, null, 2)
    );

    const preview = await readScaffoldPreview(tempDir);

    expect(preview.status).toBe("planning-baseline");
    expect(preview.label).not.toBe("Full scaffold");
  });

  it("labels a strong-confidence scaffold with real source as full", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify({ blueprintConfidence: "strong", agentMustCreateStructure: false }, null, 2)
    );
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "index.ts"), "export const x = 1;\n");

    const preview = await readScaffoldPreview(tempDir);

    expect(preview.status).toBe("full");
  });

  it("keeps weak confidence as planning baseline even when source is present (confidence gate wins)", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "scaffoldkit-input.json"),
      JSON.stringify({ blueprintConfidence: "weak" }, null, 2)
    );
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "index.ts"), "export const x = 1;\n");

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

  it("falls back to the default path when an index entry traverses outside tempDir, while legitimate entries still resolve (containment guard)", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    // A malicious/corrupt index could point an entry outside tempDir via `../`
    // segments. Mix one traversal entry with otherwise-legitimate entries so this
    // test also serves as the negative control: legitimate relative paths must
    // keep resolving normally, only the escaping entry degrades to its fallback.
    await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          generatedBy: "agent-planforge",
          rootFiles: {
            agents: "AGENTS.md",
            // Escapes tempDir: three levels up from a nested rootFiles entry
            // lands outside the temp dir entirely.
            architecture: "../../../etc/architecture-overview.md",
          },
          directories: { ai: ".ai", tasks: "tasks" },
          planning: {
            // Escapes tempDir via a single leading `../` relative traversal too
            // (not an absolute path -- an absolute-looking entry like
            // "/etc/passwd" was already contained before the guard existed,
            // since path.join re-roots it under tempDir).
            planOutput: "../outside-plan-output.json",
          },
          exports: {
            // Legitimate: stays within tempDir.
            scaffoldkit: "exports/scaffoldkit-input.json",
          },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    const resolved = await resolvePlanforgeOutputPaths(tempDir);

    expect(resolved.hasIndex).toBe(true);
    // Traversal entries degrade to the exact same fallback as a missing index
    // entry (path.join(tempDir, "<default-name>")) rather than pointing outside.
    expect(resolved.architecturePath).toBe(path.join(tempDir, "architecture-overview.md"));
    expect(resolved.planOutputPath).toBe(path.join(tempDir, "plan-output.json"));
    // Negative control: the legitimate, in-bounds entry still resolves per the
    // index, proving the guard doesn't over-reject.
    expect(resolved.scaffoldkitInputPath).toBe(path.join(tempDir, "exports", "scaffoldkit-input.json"));
  });

  it("falls back to the default path on EVERY resolved field when every index entry escapes tempDir (all-traversal, pins all four fields)", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);

    // Unlike the mixed test above (one escaping entry, others legitimate),
    // every index entry here escapes tempDir. This pins containment across
    // ALL FOUR resolved fields at once, so any future field that starts
    // resolving straight from the index (bypassing resolveArtifactPath) fails
    // this test instead of shipping unguarded.
    await fs.writeFile(
      path.join(tempDir, "planforge-index.json"),
      JSON.stringify(
        {
          generatedBy: "agent-planforge",
          rootFiles: { agents: "AGENTS.md", architecture: "../escape-architecture-overview.md" },
          directories: { ai: ".ai", tasks: "../escape-tasks" },
          planning: { planOutput: "../escape-plan-output.json" },
          exports: { scaffoldkit: "../escape-scaffoldkit-input.json" },
          ai: { agents: ".ai/AGENTS.md" },
        },
        null,
        2
      )
    );

    const resolved = await resolvePlanforgeOutputPaths(tempDir);

    expect(resolved.hasIndex).toBe(true);
    expect(resolved.tasksDir).toBe(path.join(tempDir, "tasks"));
    expect(resolved.architecturePath).toBe(path.join(tempDir, "architecture-overview.md"));
    expect(resolved.scaffoldkitInputPath).toBe(path.join(tempDir, "scaffoldkit-input.json"));
    expect(resolved.planOutputPath).toBe(path.join(tempDir, "plan-output.json"));
  });

  it("warns naming only the index key when an entry is rejected, and never logs the hostile path value", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "planforge-index.json"),
        JSON.stringify(
          {
            generatedBy: "agent-planforge",
            rootFiles: {
              agents: "AGENTS.md",
              // The single escaping entry -- everything else stays in-bounds
              // so exactly one warning fires.
              architecture: "../../../etc/hostile-secret-name.md",
            },
            directories: { ai: ".ai", tasks: "tasks" },
            planning: { planOutput: "planning/plan-output.json" },
            exports: { scaffoldkit: "exports/scaffoldkit-input.json" },
            ai: { agents: ".ai/AGENTS.md" },
          },
          null,
          2
        )
      );

      await resolvePlanforgeOutputPaths(tempDir);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toContain("rootFiles.architecture");
      // Never leak the attacker-controlled path value into logs.
      expect(message).not.toContain("etc");
      expect(message).not.toContain("hostile-secret-name");
      expect(message).not.toContain("../");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when every index entry resolves in-bounds", async () => {
    const tempDir = await makeTempDir();
    tempDirs.push(tempDir);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await fs.mkdir(path.join(tempDir, "tasks"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "planforge-index.json"),
        JSON.stringify(
          {
            generatedBy: "agent-planforge",
            rootFiles: { agents: "AGENTS.md", architecture: "architecture-overview.md" },
            directories: { ai: ".ai", tasks: "tasks" },
            planning: { planOutput: "planning/plan-output.json" },
            exports: { scaffoldkit: "exports/scaffoldkit-input.json" },
            ai: { agents: ".ai/AGENTS.md" },
          },
          null,
          2
        )
      );

      await resolvePlanforgeOutputPaths(tempDir);

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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
