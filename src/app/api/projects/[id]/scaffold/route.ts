import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { spawn } from 'child_process'
import { mkdtemp, writeFile, readFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import { rm } from 'fs/promises'

interface Props { params: Promise<{ id: string }> }

const AGENT_PLANFORGE_DIR = join(homedir(), 'git', 'agent-planforge')
const SCAFFOLDKIT_BIN = 'scaffoldkit'

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 90_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve_) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      child.kill()
      resolve_({ stdout, stderr, code: 124 })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve_({ stdout, stderr, code: code ?? 0 })
    })
  })
}

/** Recursively collect all file paths relative to root dir */
async function collectFileTree(dir: string, rootDir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await collectFileTree(fullPath, rootDir)
      files.push(...sub)
    } else {
      files.push(relative(rootDir, fullPath))
    }
  }
  return files
}

export async function POST(req: NextRequest, { params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (!existsSync(AGENT_PLANFORGE_DIR)) {
    return NextResponse.json(
      { error: `agent-planforge not found at ${AGENT_PLANFORGE_DIR}` },
      { status: 503 }
    )
  }

  let planDir: string | null = null
  let scaffoldDir: string | null = null

  try {
    // ─── Step 1: Build agent-planforge input ───────────────────────────────
    const planInput: Record<string, unknown> = {
      projectName: project.name,
      summary: (project as any).summary ?? project.description,
      targetUsers: ['developers'],
      coreFeatures: ((project as any).features as string[]) ?? [],
      constraints: ((project as any).constraints as string[]) ?? [],
    }

    planDir = await mkdtemp(join(tmpdir(), 'pf-plan-'))
    const inputPath = join(planDir, 'input.json')
    await writeFile(inputPath, JSON.stringify(planInput, null, 2))

    // ─── Step 2: Run agent-planforge ───────────────────────────────────────
    const { code: planCode, stderr: planStderr } = await runCommand(
      'node',
      [join(AGENT_PLANFORGE_DIR, 'scripts', 'bootstrap-plan.js'),
       '--input', inputPath,
       '--outdir', planDir,
       '--format', 'json'],
      planDir,
      60_000
    )

    if (planCode !== 0) {
      return NextResponse.json(
        { error: `agent-planforge failed (code ${planCode})`, details: planStderr.slice(0, 500) },
        { status: 502 }
      )
    }

    const scaffoldInputPath = join(planDir, 'scaffoldkit-input.json')
    if (!existsSync(scaffoldInputPath)) {
      return NextResponse.json({ error: 'agent-planforge did not produce scaffoldkit-input.json' }, { status: 502 })
    }

    // Read plan artifacts
    const planOutputPath = join(planDir, 'plan-output.json')
    const planArtifacts = existsSync(planOutputPath)
      ? JSON.parse(await readFile(planOutputPath, 'utf-8'))
      : null

    // ─── Step 3: Run scaffoldkit ──────────────────────────────────────────
    scaffoldDir = await mkdtemp(join(tmpdir(), 'sk-out-'))

    const { code: skCode, stderr: skStderr } = await runCommand(
      SCAFFOLDKIT_BIN,
      ['from-planforge', scaffoldInputPath, '--target', scaffoldDir, '--no-install'],
      planDir,
      60_000
    )

    if (skCode !== 0) {
      return NextResponse.json(
        { error: `scaffoldkit failed (code ${skCode})`, details: skStderr.slice(0, 500) },
        { status: 502 }
      )
    }

    // ─── Step 4: Collect file tree ────────────────────────────────────────
    const fileTree = await collectFileTree(scaffoldDir, scaffoldDir)

    // Read key generated files for preview
    const previewFiles: Record<string, string> = {}
    for (const relPath of fileTree.slice(0, 20)) {
      try {
        const content = await readFile(join(scaffoldDir, relPath), 'utf-8')
        previewFiles[relPath] = content.slice(0, 2000) // truncate large files
      } catch { /* skip binary or unreadable */ }
    }

    // ─── Step 5: Persist to DB ────────────────────────────────────────────
    await prisma.project.update({
      where: { id },
      data: {
        status: 'IMPLEMENTING',
        planArtifacts: planArtifacts ?? undefined,
        scaffoldOutDir: scaffoldDir,
      } as any,
    })

    await prisma.agentAction.create({
      data: {
        projectId: project.id,
        agentId: 'scaffoldkit',
        action: 'scaffold_generated',
        content: JSON.stringify({
          fileCount: fileTree.length,
          planArtifacts: planArtifacts ? 'loaded' : 'missing',
        }),
      },
    })

    return NextResponse.json({
      fileTree,
      previewFiles,
      planArtifacts,
      scaffoldDir,
    })
  } catch (err) {
    console.error('[scaffold] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    // Clean up plan temp dir (not scaffold — it's used by preview/commit)
    if (planDir) {
      try { await rm(planDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
