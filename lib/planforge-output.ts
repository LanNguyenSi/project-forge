import * as fs from "fs/promises";
import * as path from "path";
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

    return FULL_SCAFFOLD;
  } catch {
    return PLANNING_BASELINE;
  }
}
