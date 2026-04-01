import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { spawn } from 'child_process'
import { mkdtemp, writeFile, readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative } from 'path'
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

async function collectFileTree(dir: string, rootDir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFileTree(fullPath, rootDir))
    } else {
      files.push(relative(rootDir, fullPath))
    }
  }
  return files
}

function resolveGeneratedArtifact(baseDir: string, preferredSegments: string[], legacyName: string): string | null {
  const preferredPath = join(baseDir, ...preferredSegments)
  if (existsSync(preferredPath)) return preferredPath

  const legacyPath = join(baseDir, legacyName)
  if (existsSync(legacyPath)) return legacyPath

  return null
}

/** GET — return scaffold preview data (file tree + planArtifacts) */
export async function GET(_req: NextRequest, { params }: Props) {
  const { id } = await params
  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const scaffoldDir = (project as any).scaffoldOutDir as string | null

  if (!scaffoldDir || !existsSync(scaffoldDir)) {
    return NextResponse.json({ error: 'No scaffold data — run POST /scaffold first' }, { status: 404 })
  }

  const fileTree = await collectFileTree(scaffoldDir, scaffoldDir)
  const previewFiles: Record<string, string> = {}
  for (const relPath of fileTree.slice(0, 20)) {
    try {
      const content = await readFile(join(scaffoldDir, relPath), 'utf-8')
      previewFiles[relPath] = content.slice(0, 3000)
    } catch { /* skip */ }
  }

  return NextResponse.json({
    fileTree,
    previewFiles,
    planArtifacts: (project as any).planArtifacts ?? null,
  })
}

/** POST — run scaffold pipeline (agent-planforge → scaffoldkit)
 *  Optional body: { summary?, features?, constraints? } to override project defaults
 */
export async function POST(req: NextRequest, { params }: Props) {
  const { id } = await params
  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  if (!existsSync(AGENT_PLANFORGE_DIR)) {
    return NextResponse.json({ error: `agent-planforge not found at ${AGENT_PLANFORGE_DIR}` }, { status: 503 })
  }

  // Accept optional overrides from body
  let overrides: { summary?: string; features?: string[]; constraints?: string[] } = {}
  try {
    const body = await req.json()
    if (body && typeof body === 'object') overrides = body as typeof overrides
  } catch { /* no body or invalid JSON — use project defaults */ }

  let planDir: string | null = null
  let scaffoldDir: string | null = null

  try {
    const planInput: Record<string, unknown> = {
      projectName: project.name,
      summary: overrides.summary?.trim() || (project as any).summary || project.description,
      targetUsers: ['developers'],
      coreFeatures: overrides.features?.filter(Boolean) ?? ((project as any).features as string[]) ?? [],
      constraints: overrides.constraints?.filter(Boolean) ?? ((project as any).constraints as string[]) ?? [],
    }

    planDir = await mkdtemp(join(tmpdir(), 'pf-plan-'))
    const inputPath = join(planDir, 'input.json')
    await writeFile(inputPath, JSON.stringify(planInput, null, 2))

    const { code: planCode, stderr: planStderr } = await runCommand(
      'node',
      [join(AGENT_PLANFORGE_DIR, 'scripts', 'bootstrap-plan.js'), '--input', inputPath, '--outdir', planDir, '--format', 'json'],
      planDir, 60_000
    )
    if (planCode !== 0) {
      return NextResponse.json({ error: `agent-planforge failed (code ${planCode})`, details: planStderr.slice(0, 500) }, { status: 502 })
    }

    const scaffoldInputPath = resolveGeneratedArtifact(
      planDir,
      ['exports', 'scaffoldkit-input.json'],
      'scaffoldkit-input.json'
    )
    if (!scaffoldInputPath) {
      return NextResponse.json({ error: 'agent-planforge did not produce scaffoldkit-input.json' }, { status: 502 })
    }

    const planOutputPath = resolveGeneratedArtifact(
      planDir,
      ['planning', 'plan-output.json'],
      'plan-output.json'
    )
    const planArtifacts = planOutputPath
      ? JSON.parse(await readFile(planOutputPath, 'utf-8'))
      : null

    scaffoldDir = await mkdtemp(join(tmpdir(), 'sk-out-'))
    const { code: skCode, stderr: skStderr } = await runCommand(
      SCAFFOLDKIT_BIN,
      ['from-planforge', scaffoldInputPath, '--target', scaffoldDir, '--no-install'],
      planDir, 60_000
    )
    if (skCode !== 0) {
      return NextResponse.json({ error: `scaffoldkit failed (code ${skCode})`, details: skStderr.slice(0, 500) }, { status: 502 })
    }

    const fileTree = await collectFileTree(scaffoldDir, scaffoldDir)
    const previewFiles: Record<string, string> = {}
    for (const relPath of fileTree.slice(0, 20)) {
      try {
        const content = await readFile(join(scaffoldDir, relPath), 'utf-8')
        previewFiles[relPath] = content.slice(0, 2000)
      } catch { /* skip */ }
    }

    await prisma.project.update({
      where: { id },
      data: { status: 'IMPLEMENTING', planArtifacts: planArtifacts ?? undefined, scaffoldOutDir: scaffoldDir } as any,
    })
    await prisma.agentAction.create({
      data: { projectId: project.id, agentId: 'scaffoldkit', action: 'scaffold_generated', content: JSON.stringify({ fileCount: fileTree.length }) },
    })

    return NextResponse.json({ fileTree, previewFiles, planArtifacts, scaffoldDir })
  } catch (err) {
    console.error('[scaffold] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    if (planDir) { try { await rm(planDir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}
