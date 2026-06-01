import * as fs from "fs/promises";
import * as path from "path";
import { collectRuntimePaths, hasRuntimeSignals } from "@/lib/runtime-signals";
import type { ScaffoldPreview } from "@/lib/types";

type PathMap = Record<string, string>;

interface PlanforgeIndex {
  generatedBy?: string;
  rootFiles: PathMap;
  directories: PathMap;
  planning: PathMap;
  exports: PathMap;
  ai: PathMap;
  // Optional: agent-planforge drops this block once the runner/handoff vision
  // is removed (Phase 3). Every other block above is required by isPlanforgeIndex.
  handoff?: PathMap;
}

export interface ResolvedPlanforgeOutputPaths {
  hasIndex: boolean;
  indexPath: string | null;
  tasksDir: string;
  architecturePath: string;
  scaffoldkitInputPath: string;
  planOutputPath: string;
}

const PLANNING_BASELINE: ScaffoldPreview = {
  status: "planning-baseline",
  label: "Planning baseline only",
  summary:
    "Plan, tasks, architecture, and agent guidance are ready. Resolve any wave-0 scaffold-fit review before relying on the generated structure for implementation.",
};

const FULL_SCAFFOLD: ScaffoldPreview = {
  status: "full",
  label: "Full scaffold",
  summary: "The initial repository structure is scaffolded and ready for implementation.",
};

function isPathMap(value: unknown): value is PathMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string" && entry.length > 0);
}

function isPlanforgeIndex(value: unknown): value is PlanforgeIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as PlanforgeIndex;
  return (
    candidate.generatedBy === "agent-planforge" &&
    isPathMap(candidate.rootFiles) &&
    isPathMap(candidate.directories) &&
    isPathMap(candidate.planning) &&
    // handoff is optional: agent-planforge stopped emitting the runner/handoff
    // block (Phase 3). Accept an index with no handoff key, but still validate
    // it when present so a malformed block is rejected.
    (candidate.handoff === undefined || isPathMap(candidate.handoff)) &&
    isPathMap(candidate.exports) &&
    isPathMap(candidate.ai)
  );
}

async function readPlanforgeIndex(indexPath: string): Promise<PlanforgeIndex | null> {
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isPlanforgeIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveArtifactPath(tempDir: string, relativePath: string | undefined, fallbackPath: string): string {
  return relativePath ? path.join(tempDir, relativePath) : fallbackPath;
}

export async function resolvePlanforgeOutputPaths(tempDir: string): Promise<ResolvedPlanforgeOutputPaths> {
  const indexPath = path.join(tempDir, "planforge-index.json");
  const index = await readPlanforgeIndex(indexPath);

  if (!index) {
    return {
      hasIndex: false,
      indexPath: null,
      tasksDir: path.join(tempDir, "tasks"),
      architecturePath: path.join(tempDir, "architecture-overview.md"),
      scaffoldkitInputPath: path.join(tempDir, "scaffoldkit-input.json"),
      planOutputPath: path.join(tempDir, "plan-output.json"),
    };
  }

  return {
    hasIndex: true,
    indexPath,
    tasksDir: resolveArtifactPath(tempDir, index.directories?.tasks, path.join(tempDir, "tasks")),
    architecturePath: resolveArtifactPath(
      tempDir,
      index.rootFiles?.architecture,
      path.join(tempDir, "architecture-overview.md")
    ),
    scaffoldkitInputPath: resolveArtifactPath(
      tempDir,
      index.exports?.scaffoldkit,
      path.join(tempDir, "scaffoldkit-input.json")
    ),
    planOutputPath: resolveArtifactPath(
      tempDir,
      index.planning?.planOutput,
      path.join(tempDir, "plan-output.json")
    ),
  };
}

export async function readScaffoldPreview(tempDir: string): Promise<ScaffoldPreview> {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);

  try {
    const raw = await fs.readFile(artifacts.scaffoldkitInputPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      blueprintConfidence?: string;
      agentMustCreateStructure?: boolean;
    };

    if (parsed.agentMustCreateStructure || parsed.blueprintConfidence === "weak") {
      return PLANNING_BASELINE;
    }

    // A strong blueprint selection is not enough: if the scaffold emitted no real
    // source (only a manifest plus empty dirs), it is a planning baseline, not a
    // "full scaffold". Reuse the exact source-file signal #82 added to the
    // post-scaffold review verdict so the preview label and the verdict agree.
    const runtimeIndicators = await collectRuntimePaths(tempDir);
    if (!hasRuntimeSignals(runtimeIndicators)) {
      return PLANNING_BASELINE;
    }

    return FULL_SCAFFOLD;
  } catch {
    return PLANNING_BASELINE;
  }
}

// Generation-only planforge artifacts: downstream tools read these at
// generation time (planforge resume reads plan-output.json; scaffoldkit and
// project-forge read scaffoldkit-input.json before publish), but they have no
// value once committed into the deliverable. They are kept out of the published
// repo via .git/info/exclude, which is local to the temp clone and so never
// collides with scaffoldkit's own committed root .gitignore.
// The entire planning/ directory is planforge generation/replanning state
// (plan-output.json + structured-input.json + rerun-report.json +
// rerun-summary.md). Downstream tools read these at generation time from disk
// before publish, so none of it belongs in the committed deliverable.
export const PLANFORGE_PUBLISH_EXCLUDES = [
  "/planning/",
  "/exports/scaffoldkit-input.json",
];

export async function excludePlanforgeArtifactsFromPublish(projectDir: string): Promise<void> {
  // Derive the actual artifact locations from the generated index so the
  // exclude list tracks whatever layout planforge emits (e.g. a future move
  // under .planforge/) instead of drifting from hardcoded paths. Fall back to
  // the current default paths only when no index is present.
  const resolved = await resolvePlanforgeOutputPaths(projectDir);
  const toPattern = (absolutePath: string) =>
    `/${path.relative(projectDir, absolutePath).split(path.sep).join("/")}`;
  // Exclude the whole planning/ directory (the parent of plan-output.json) so
  // structured-input.json + rerun-report.json + rerun-summary.md and any future
  // planning-only artifact are kept out too, not just plan-output.json. Guard
  // against a flat layout where plan-output.json sits at the repo root: never
  // turn that into a "/" exclude that would drop the entire deliverable.
  let excludes: string[];
  if (resolved.hasIndex) {
    const planningRel = path
      .relative(projectDir, path.dirname(resolved.planOutputPath))
      .split(path.sep)
      .join("/");
    const planningDirPattern =
      planningRel && !planningRel.startsWith("..")
        ? `/${planningRel}/`
        : toPattern(resolved.planOutputPath);
    excludes = [planningDirPattern, toPattern(resolved.scaffoldkitInputPath)];
  } else {
    excludes = PLANFORGE_PUBLISH_EXCLUDES;
  }

  // Never emit a bare "/" (or empty) pattern: a degenerate index value such as
  // planOutput="." would resolve the planning directory to the repo root. A
  // bare "/" is a git no-op in practice, but drop it defensively so the exclude
  // block can never target the whole deliverable.
  excludes = excludes.filter((pattern) => pattern && pattern !== "/");

  const excludePath = path.join(projectDir, ".git", "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const existing = await fs.readFile(excludePath, "utf-8").catch(() => "");
  const block = [
    "# planforge generation-only artifacts (kept out of the deliverable)",
    ...excludes,
  ].join("\n");
  if (existing.includes(block)) {
    return;
  }
  const next = existing.trim()
    ? `${existing.replace(/\n+$/, "")}\n${block}\n`
    : `${block}\n`;
  await fs.writeFile(excludePath, next);
}
