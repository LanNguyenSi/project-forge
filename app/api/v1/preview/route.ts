import { NextRequest, NextResponse } from "next/server";
import { validateApiToken } from "@/lib/db";
import * as fs from "fs/promises";
import * as path from "path";
import type { Task, FileTreeNode, ErrorResponse } from "@/lib/types";
import { readScaffoldPreview, resolvePlanforgeOutputPaths } from "@/lib/planforge-output";
import { readPostScaffoldReview, toScaffoldFitPreview } from "@/lib/post-scaffold-review";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "Missing sessionId parameter" }, { status: 400 });
  }

  // Validate UUID format to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "Invalid sessionId format" }, { status: 400 });
  }

  const tempDir = path.join(TEMP_ROOT, sessionId);

  try {
    const stat = await fs.stat(tempDir).catch(() => null);
    if (!stat) {
      return NextResponse.json({ ok: false, error: "Session not found or expired" }, { status: 404 });
    }

    // Check TTL
    if (Date.now() - stat.mtimeMs > SESSION_TTL_MS) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json({ ok: false, error: "Session expired" }, { status: 404 });
    }

    // Verify ownership
    const metaPath = path.join(tempDir, ".forge-meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
      tokenId: string;
      userId: string;
      projectName: string;
    };

    if (meta.userId !== tokenRecord.userId) {
      return NextResponse.json({ ok: false, error: "Session not found or expired" }, { status: 404 });
    }

    // Read preview data
    const artifacts = await resolvePlanforgeOutputPaths(tempDir);
    const tasksDir = artifacts.tasksDir;
    const taskFiles = (await fs.readdir(tasksDir).catch(() => [])).filter((f) => f.endsWith(".md"));

    const tasks: Task[] = await Promise.all(
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

    const architectureOverview = await fs.readFile(artifacts.architecturePath, "utf-8").catch(() => "(not generated)");
    const scaffold = await readScaffoldPreview(tempDir);
    const scaffoldFit = toScaffoldFitPreview(await readPostScaffoldReview(tempDir));
    const fileTree = await buildFileTree(tempDir);
    const waves = new Set(tasks.map((t) => t.wave));

    return NextResponse.json({
      ok: true,
      sessionId,
      preview: {
        projectName: meta.projectName,
        tasks,
        architectureOverview,
        fileTree,
        scaffold,
        scaffoldFit,
        taskCount: tasks.length,
        waveCount: waves.size,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Failed to read preview", details: msg },
      { status: 500 },
    );
  }
}

async function buildFileTree(dirPath: string, basePath = ""): Promise<FileTreeNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];
  const skipDirs = new Set(["node_modules", ".git", "venv", "__pycache__"]);
  const skipFiles = new Set([".forge-meta.json"]);

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
