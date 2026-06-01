import * as fs from "fs/promises";
import * as path from "path";

// Shared runtime-structure detection: did the scaffold emit real source code, or
// only a manifest plus empty directories? Both the post-scaffold review (the
// verdict) and the scaffold preview (the "Full scaffold" vs "Planning baseline"
// label) must agree on this signal, so it lives here as a single source of truth
// instead of being duplicated across lib/post-scaffold-review.ts and
// lib/planforge-output.ts.

// Planforge artifacts that should NOT be counted as runtime scaffold signals.
// Since the output reorganization (bf7a491), most JSON files moved into
// planning/, handoff/, and exports/ subdirectories, and the planning prose
// docs now live under .planforge/docs/. The directory entries below cover
// the subdirs (including the .planforge/ namespace) and the root-level
// markdown/index files. The bare root-level doc names are retained so older
// flat-root tarballs still match.
export const PLANFORGE_TOP_LEVEL_PATHS = new Set([
  // Directories
  ".ai",
  ".planforge",
  "adrs",
  "exports",
  "governance",
  // Back-compat: agent-planforge stops emitting handoff/ once the runner vision
  // is removed (Phase 3). Retained so older flat tarballs still match; safe to
  // drop after the migration window.
  "handoff",
  "planning",
  "prompts",
  "runbooks",
  "specs",
  "tasks",
  // Root-level files
  "AGENTS.md",
  "BRANCH_INFO.md",
  "CLAUDE.md",
  "PROJECT.md",
  "architecture-overview.md",
  "delivery-plan.md",
  "intake-questionnaire.md",
  "planforge-index.json",
  "project-charter.md",
  "project-input.json",
]);

// "Runtime structure present" means actual source code was generated, not just
// a manifest (pyproject.toml / package.json) or a bare src/ directory. An empty
// scaffold (e.g. a non-TypeScript selection of a TS-only blueprint) leaves a
// manifest plus empty dirs; treating those as runtime structure is exactly the
// "full scaffold" overclaim this check exists to catch, so require a real
// source file instead.
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".php", ".java", ".kt",
  ".cs", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".scala", ".ex", ".exs", ".clj", ".sql",
]);

export async function collectRuntimePaths(rootDir: string, maxPaths = 60): Promise<{ topLevelPaths: string[]; samplePaths: string[] }> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const topLevelPaths = entries
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !PLANFORGE_TOP_LEVEL_PATHS.has(name) &&
        name !== ".git" &&
        name !== "node_modules" &&
        // forge-internal bookkeeping written during generation and removed before
        // publish; never part of the deliverable, so it must not be snapshotted as
        // runtime structure in the post-scaffold review.
        name !== ".forge-meta.json" &&
        name !== ".forge-published"
    )
    .sort();

  const samplePaths: string[] = [];

  async function visit(relativeDir: string) {
    if (samplePaths.length >= maxPaths) {
      return;
    }

    const fullDir = path.join(rootDir, relativeDir);
    const children = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);

    for (const child of children) {
      if (samplePaths.length >= maxPaths) {
        return;
      }

      const childRelative = relativeDir ? path.join(relativeDir, child.name) : child.name;
      if (child.name === ".git" || child.name === "node_modules") {
        continue;
      }

      samplePaths.push(childRelative);
      if (child.isDirectory()) {
        await visit(childRelative);
      }
    }
  }

  for (const topLevelPath of topLevelPaths) {
    if (samplePaths.length >= maxPaths) {
      break;
    }
    await visit(topLevelPath);
  }

  return {
    topLevelPaths,
    samplePaths,
  };
}

export function hasRuntimeSignals(runtimeIndicators: { topLevelPaths: string[]; samplePaths: string[] }): boolean {
  // A generated source file (top-level or in any sampled directory, at any
  // depth) is the honest signal that runtime structure exists. A bare src/ dir
  // or a lone manifest does not count.
  return [...runtimeIndicators.topLevelPaths, ...runtimeIndicators.samplePaths].some(
    (filePath) => SOURCE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}
