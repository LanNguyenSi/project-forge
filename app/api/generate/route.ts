import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ProjectInput,
  GenerateResponse,
  ErrorResponse,
  Task,
  FileTreeNode,
} from '../../../lib/types';
import { readScaffoldPreview, resolvePlanforgeOutputPaths } from '@/lib/planforge-output';
import { buildPlanforgeInput } from '@/lib/planforge-orchestrator';
import { runPlanforgeViaHttp, PlanforgeClientError } from '@/lib/planforge-client';
import { readPostScaffoldReview, runPostScaffoldReview, toScaffoldFitPreview } from '@/lib/post-scaffold-review';

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? '/tmp/project-forge';
const GENERATION_TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest) {
  let sessionId: string | null = null;

  try {
    const input: ProjectInput = await req.json();

    if (!input.projectName || !input.summary) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: 'Missing required fields: projectName, summary' },
        { status: 400 }
      );
    }

    sessionId = randomUUID();
    const tempDir = path.join(TEMP_ROOT, sessionId);
    await fs.mkdir(tempDir, { recursive: true });

    // Plan + scaffold via the planforge HTTP service. The response tarball
    // contains both planning artifacts and the scaffolded project tree;
    // they're extracted directly into tempDir so downstream code reads
    // from the same layout the legacy subprocess produced.
    const { planforgeInput } = await buildPlanforgeInput(input);
    const baseUrl = process.env.PLANFORGE_URL;
    const token = process.env.PLANFORGE_SERVICE_TOKEN;
    if (!baseUrl || !token) {
      throw new PlanforgeClientError(
        'PLANFORGE_URL and PLANFORGE_SERVICE_TOKEN are required',
      );
    }
    await runPlanforgeViaHttp({
      baseUrl,
      token,
      input: planforgeInput,
      outdir: tempDir,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
    const artifacts = await resolvePlanforgeOutputPaths(tempDir);

    await runPostScaffoldReview(tempDir);

    // Parse planforge output
    const tasksDir = artifacts.tasksDir;
    const archPath = artifacts.architecturePath;

    const taskFiles = (await fs.readdir(tasksDir).catch(() => [])).filter(
      (f) => f.endsWith('.md')
    );

    const tasks: Task[] = await Promise.all(
      taskFiles.map(async (file) => {
        const content = await fs.readFile(path.join(tasksDir, file), 'utf-8');
        const idMatch = file.match(/^(\d+)-/);
        const titleMatch = content.match(/# Task \d+[:\s]+(.+)/);
        const waveMatch = content.match(/## Wave\s*\n\s*\n\s*(.+)/);
        const categoryMatch = content.match(/## Category\s*\n\s*\n\s*(.+)/);
        const priorityMatch = content.match(/## Priority\s*\n\s*\n\s*(.+)/);
        const summaryMatch = content.match(/## Summary\s*\n\s*\n\s*(.+)/);
        const dependsOnMatch = content.match(/## Depends On\s*\n\s*\n\s*([\s\S]*?)(?=\n## )/);
        const dependsOn = dependsOnMatch?.[1]
          ?.split('\n')
          .map((line) => line.replace(/^-\s*/, '').trim())
          .filter(Boolean);
        return {
          id: idMatch?.[1] ?? file.replace('.md', ''),
          title: (titleMatch?.[1] ?? file).trim(),
          wave: (waveMatch?.[1] ?? 'wave-1').trim(),
          category: (categoryMatch?.[1] ?? 'feature').trim(),
          priority: (priorityMatch?.[1] ?? 'P1').trim(),
          summary: summaryMatch?.[1]?.trim(),
          ...(dependsOn?.length ? { dependsOn } : {}),
        };
      })
    );

    const architectureOverview = await fs
      .readFile(archPath, 'utf-8')
      .catch(() => '(Architecture overview not generated)');
    const scaffold = await readScaffoldPreview(tempDir);
    const scaffoldFit = toScaffoldFitPreview(await readPostScaffoldReview(tempDir));

    const fileTree = await buildFileTree(tempDir);

    const waves = new Set(tasks.map((t) => t.wave));

    const response: GenerateResponse = {
      ok: true,
      preview: {
        sessionId,
        projectName: input.projectName,
        scaffold,
        scaffoldFit,
        tasks,
        architectureOverview,
        fileTree,
        taskCount: tasks.length,
        waveCount: waves.size,
      },
    };

    return NextResponse.json(response);
  } catch (error: any) {
    console.error('Generation failed:', error);

    if (sessionId) {
      const tempDir = path.join(TEMP_ROOT, sessionId);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json<ErrorResponse>(
      {
        ok: false,
        error: 'Failed to generate project',
        details: error.message,
      },
      { status: 500 }
    );
  }
}

async function buildFileTree(
  dirPath: string,
  basePath = ''
): Promise<FileTreeNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  // Skip certain directories
  const skipDirs = new Set(['node_modules', '.git', 'venv', '__pycache__']);

  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;

    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, relativePath);
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children,
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
      });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}
