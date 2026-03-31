import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
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
import { executePlanforgeWorkflow } from '@/lib/planforge-runner';
import { readPostScaffoldReview, toScaffoldFitPreview } from '@/lib/post-scaffold-review';

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? '/tmp/project-forge';
const PLANFORGE_PATH = process.env.PLANFORGE_PATH ?? '/root/.openclaw/workspace/git/agent-planforge';
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

    const { planforgeInput } = await buildPlanforgeInput(input);

    const inputPath = path.join(tempDir, 'project-input.json');
    await fs.writeFile(inputPath, JSON.stringify(planforgeInput, null, 2));

    await executePlanforgeWorkflow({
      planforgePath: PLANFORGE_PATH,
      inputPath,
      outdir: tempDir,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });

    // Parse output
    const artifacts = await resolvePlanforgeOutputPaths(tempDir);
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
        return {
          id: idMatch?.[1] ?? file.replace('.md', ''),
          title: (titleMatch?.[1] ?? file).trim(),
          wave: (waveMatch?.[1] ?? 'wave-1').trim(),
          category: (categoryMatch?.[1] ?? 'feature').trim(),
          priority: (priorityMatch?.[1] ?? 'P1').trim(),
          summary: summaryMatch?.[1]?.trim(),
        };
      })
    );

    let architectureOverview = '(Architecture overview not generated)';
    try {
      architectureOverview = await fs.readFile(archPath, 'utf-8');
    } catch { /* ignore */ }
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
  } catch (error: unknown) {
    console.error('planforge execution failed:', error);
    if (sessionId) {
      const tempDir = path.join(TEMP_ROOT, sessionId);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: 'Failed to generate project plan', details: msg },
      { status: 500 }
    );
  }
}

async function buildFileTree(dirPath: string, basePath = ''): Promise<FileTreeNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const children = await buildFileTree(fullPath, relativePath);
      nodes.push({ name: entry.name, path: relativePath, type: 'directory', children });
    } else {
      nodes.push({ name: entry.name, path: relativePath, type: 'file' });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}
