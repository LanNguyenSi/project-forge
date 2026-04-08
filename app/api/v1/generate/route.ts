import { NextRequest, NextResponse } from "next/server";
import { validateApiToken, checkRateLimit } from "@/lib/db";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { Task, FileTreeNode, ErrorResponse } from "@/lib/types";
import { readScaffoldPreview, resolvePlanforgeOutputPaths } from "@/lib/planforge-output";
import { buildPlanforgeInput } from "@/lib/planforge-orchestrator";
import { executePlanforgeWorkflow } from "@/lib/planforge-runner";
import { readPostScaffoldReview, runPostScaffoldReview, toScaffoldFitPreview } from "@/lib/post-scaffold-review";
import { runCommand } from "@/lib/subprocess";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const PLANFORGE_PATH = process.env.PLANFORGE_PATH ?? "/root/.openclaw/workspace/git/agent-planforge";
const GENERATION_TIMEOUT_MS = 30_000;

interface GenerateRequest {
  projectName: string;
  summary: string;
  features?: string[];
  constraints?: string[];
  targetUsers?: string[];
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(tokenRecord.userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Rate limit exceeded", details: `Used: ${rateLimit.used}/10` },
      { status: 429 },
    );
  }

  let sessionId: string | null = null;

  try {
    const input: GenerateRequest = await req.json();

    if (!input.projectName || !input.summary) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: projectName, summary" },
        { status: 400 },
      );
    }

    sessionId = randomUUID();
    const tempDir = path.join(TEMP_ROOT, sessionId);
    await fs.mkdir(tempDir, { recursive: true });

    // Store metadata for later preview/publish
    await fs.writeFile(
      path.join(tempDir, ".forge-meta.json"),
      JSON.stringify({
        tokenId: tokenRecord.id,
        userId: tokenRecord.userId,
        projectName: input.projectName,
        createdAt: new Date().toISOString(),
      }),
    );

    // Step 1: Run planforge
    const { planforgeInput } = await buildPlanforgeInput({
      projectName: input.projectName,
      summary: input.summary,
      features: input.features ?? [],
      constraints: input.constraints ?? [],
      targetUsers: input.targetUsers,
    });

    const inputPath = path.join(tempDir, "project-input.json");
    await fs.writeFile(inputPath, JSON.stringify(planforgeInput, null, 2));

    await executePlanforgeWorkflow({
      planforgePath: PLANFORGE_PATH,
      inputPath,
      outdir: tempDir,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });

    // Step 2: Run scaffoldkit
    const artifacts = await resolvePlanforgeOutputPaths(tempDir);
    const scaffoldkitPython = process.env.SCAFFOLDKIT_PYTHON ?? "/tmp/sk-venv/bin/python3";
    const scaffoldkitExists = await fs.access(artifacts.scaffoldkitInputPath).then(() => true).catch(() => false);

    if (scaffoldkitExists) {
      await runCommand(
        scaffoldkitPython,
        ["-m", "scaffoldkit.cli", "from-planforge", artifacts.scaffoldkitInputPath, "--target", tempDir, "--overwrite", "--no-install"],
        { cwd: tempDir, timeoutMs: GENERATION_TIMEOUT_MS, verbose: true },
      ).catch((err: Error) => {
        console.error("scaffoldkit failed (non-blocking):", err.message);
      });
    }

    await runPostScaffoldReview(tempDir);

    // Parse output
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
        projectName: input.projectName,
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
    console.error("Generation failed:", error);

    if (sessionId) {
      const tempDir = path.join(TEMP_ROOT, sessionId);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Generation failed", details: msg },
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
