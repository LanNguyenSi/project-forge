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
  tokenId: string;
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

export async function parseTasks(tempDir: string): Promise<Task[]> {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);
  const tasksDir = artifacts.tasksDir;
  const taskFiles = (await fs.readdir(tasksDir).catch(() => [])).filter((f) => f.endsWith(".md"));

  return Promise.all(
    taskFiles.map(async (file) => {
      const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
      const idMatch = file.match(/^(\d+)-/);
      const titleMatch = content.match(/# Task \d+[:\s]+(.+)/);
      const waveMatch = content.match(/## Wave\s*\n\s*\n\s*(.+)/);
      const categoryMatch = content.match(/## Category\s*\n\s*\n\s*(.+)/);
      const priorityMatch = content.match(/## Priority\s*\n\s*\n\s*(.+)/);
      const summaryMatch = content.match(/## Summary\s*\n\s*\n\s*(.+)/);
      return {
        id: idMatch?.[1] ?? file.replace(".md", ""),
        title: (titleMatch?.[1] ?? file).trim(),
        wave: (waveMatch?.[1] ?? "wave-1").trim(),
        category: (categoryMatch?.[1] ?? "feature").trim(),
        priority: (priorityMatch?.[1] ?? "P1").trim(),
        summary: summaryMatch?.[1]?.trim(),
      };
    }),
  );
}

export async function readPreviewData(tempDir: string, projectName: string) {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);
  const tasks = await parseTasks(tempDir);
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
