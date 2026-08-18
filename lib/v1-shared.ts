import * as fs from "fs/promises";
import * as path from "path";
import type { Task, FileTreeNode } from "./types";
import { readScaffoldPreview, resolvePlanforgeOutputPaths } from "./planforge-output";
import { readPostScaffoldReview, toScaffoldFitPreview } from "./post-scaffold-review";

const PROJECT_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export function validateProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name);
}

export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ForgeMeta {
  // Present only for v1 (API-token) sessions; the legacy NextAuth-driven
  // generate route writes meta without a token, so this is optional.
  tokenId?: string;
  userId: string;
  projectName: string;
  createdAt: string;
}

export async function readForgeMeta(tempDir: string): Promise<ForgeMeta> {
  const raw = await fs.readFile(path.join(tempDir, ".forge-meta.json"), "utf-8");
  return JSON.parse(raw) as ForgeMeta;
}

export function isSessionExpired(meta: ForgeMeta): boolean {
  return Date.now() - new Date(meta.createdAt).getTime() > SESSION_TTL_MS;
}

// Raw per-file parse result, kept internal to this module. `wave` is left
// undefined when the file has no "## Wave" section at all -- parseTasks()
// applies the "wave-1" default on top of this, while readPreviewData() uses
// the undefined state itself as the signal for backfilling wave from
// plan-output.json (a real "## Wave" section always wins over the backfill;
// see readPreviewData below).
interface ParsedTaskFile {
  id: string;
  title: string;
  wave?: string;
  category: string;
  priority: string;
  summary?: string;
}

function parseTaskFile(file: string, content: string): ParsedTaskFile {
  const idMatch = file.match(/^(\d+)-/);
  const titleMatch = content.match(/# Task \d+[:\s]+(.+)/);
  const waveMatch = content.match(/## Wave\s*\n\s*\n\s*(.+)/);
  const categoryMatch = content.match(/## Category\s*\n\s*\n\s*(.+)/);
  const priorityMatch = content.match(/## Priority\s*\n\s*\n\s*(.+)/);
  const summaryMatch = content.match(/## Summary\s*\n\s*\n\s*(.+)/);
  return {
    id: idMatch?.[1] ?? file.replace(".md", ""),
    title: (titleMatch?.[1] ?? file).trim(),
    wave: waveMatch?.[1]?.trim(),
    category: (categoryMatch?.[1] ?? "feature").trim(),
    priority: (priorityMatch?.[1] ?? "P1").trim(),
    summary: summaryMatch?.[1]?.trim(),
  };
}

async function parseTaskFiles(tempDir: string): Promise<ParsedTaskFile[]> {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);
  const tasksDir = artifacts.tasksDir;
  const taskFiles = (await fs.readdir(tasksDir).catch(() => [])).filter((f) => f.endsWith(".md"));

  return Promise.all(
    taskFiles.map(async (file) => {
      const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
      return parseTaskFile(file, content);
    }),
  );
}

export async function parseTasks(tempDir: string): Promise<Task[]> {
  const parsed = await parseTaskFiles(tempDir);
  return parsed.map((p) => ({
    id: p.id,
    title: p.title,
    wave: p.wave ?? "wave-1",
    category: p.category,
    priority: p.priority,
    summary: p.summary,
  }));
}

// Subset of a plan-output.json tasks[] entry this module cares about.
interface PlanOutputTaskEntry {
  dependsOn?: string[];
  wave?: string;
}

// Reads plan-output.json (path resolved via resolvePlanforgeOutputPaths, never
// hardcoded, so index-driven layouts are honored) and indexes its tasks[] by
// id. Missing file, corrupt JSON, or a malformed tasks[] entry all degrade to
// an empty map -- i.e. today's behavior (no dependsOn, no wave backfill) --
// mirroring the .catch(() => fallback) convention readPreviewData already
// uses for architectureOverview: a broken plan-output.json must never turn a
// generate/preview request into a 500.
async function readPlanOutputTasksById(planOutputPath: string): Promise<Map<string, PlanOutputTaskEntry>> {
  const byId = new Map<string, PlanOutputTaskEntry>();
  try {
    const raw = await fs.readFile(planOutputPath, "utf-8");
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    for (const entry of tasks) {
      if (!entry || typeof entry !== "object") continue;
      const { id, dependsOn, wave } = entry as { id?: unknown; dependsOn?: unknown; wave?: unknown };
      if (typeof id !== "string") continue;
      byId.set(id, {
        dependsOn: Array.isArray(dependsOn)
          ? dependsOn.filter((depId): depId is string => typeof depId === "string")
          : undefined,
        wave: typeof wave === "string" ? wave : undefined,
      });
    }
  } catch {
    // Missing or corrupt plan-output.json: degrade to no dependsOn/wave data.
  }
  return byId;
}

export async function readPreviewData(tempDir: string, projectName: string) {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);
  const parsedTaskFiles = await parseTaskFiles(tempDir);
  const planOutputById = await readPlanOutputTasksById(artifacts.planOutputPath);

  // The id space parsed from tasks/*.md matches plan-output.json's tasks[].id
  // by construction: agent-planforge's bootstrap-plan.js writes each task file
  // as `tasks/${task.id}-${slug}.md` using the zero-padded id straight from
  // plan-output.json, and parseTaskFile's /^(\d+)-/ prefix match recovers that
  // exact string back out of the filename. So a plain string-keyed Map join
  // (no normalization) is correct, and `knownIds` below is exactly "the ids
  // present in this response".
  const knownIds = new Set(parsedTaskFiles.map((p) => p.id));

  const tasks: Task[] = parsedTaskFiles.map((p) => {
    const planEntry = planOutputById.get(p.id);
    const task: Task = {
      id: p.id,
      title: p.title,
      // Backfill only: an explicit "## Wave" section in the task file always
      // wins. plan-output.json's wave fills in only when the file had none
      // (p.wave undefined) -- it must never overwrite a file-declared wave.
      wave: p.wave ?? planEntry?.wave ?? "wave-1",
      category: p.category,
      priority: p.priority,
      summary: p.summary,
    };

    // dependsOn ids live in the same id space as this response's own parsed
    // task ids (see knownIds above). An id that does not resolve to another
    // task in THIS response is dropped defensively -- mirrors project-pilot's
    // topoSortForgeTasks dangling-id drop, guarding against a stale or
    // foreign dependsOn edge (e.g. from a partially-regenerated plan) leaking
    // into the API response. The Set also dedups a plan listing the same
    // dependency twice. An empty result omits the field (undefined) rather
    // than serializing [].
    const dependsOn = [...new Set(planEntry?.dependsOn ?? [])].filter((depId) => knownIds.has(depId));
    if (dependsOn.length > 0) {
      task.dependsOn = dependsOn;
    }

    return task;
  });

  const architectureOverview = await fs.readFile(artifacts.architecturePath, "utf-8").catch(() => "(not generated)");
  const scaffold = await readScaffoldPreview(tempDir);
  const scaffoldFit = toScaffoldFitPreview(await readPostScaffoldReview(tempDir));
  const fileTree = await buildFileTree(tempDir);
  const waves = new Set(tasks.map((t) => t.wave));

  return {
    projectName,
    tasks,
    architectureOverview,
    fileTree,
    scaffold,
    scaffoldFit,
    taskCount: tasks.length,
    waveCount: waves.size,
  };
}

export async function buildFileTree(dirPath: string, basePath = ""): Promise<FileTreeNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];
  const skipDirs = new Set(["node_modules", ".git", "venv", "__pycache__"]);
  const skipFiles = new Set([".forge-meta.json", ".forge-published"]);

  for (const entry of entries) {
    if (skipDirs.has(entry.name) || skipFiles.has(entry.name)) continue;
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, relativePath);
      nodes.push({ name: entry.name, path: relativePath, type: "directory", children });
    } else {
      nodes.push({ name: entry.name, path: relativePath, type: "file" });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}
