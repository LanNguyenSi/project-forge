import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { spawn } from 'child_process'
import { mkdtemp, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { rm } from 'fs/promises'

interface Props {
  params: Promise<{ id: string }>
}

/**
 * Parse planforge plan output markdown to extract tasks.
 * Looks for numbered items under "## Step-by-Step Plan" section.
 */
function parsePlanToTasks(markdown: string): Array<{ title: string; description: string }> {
  const tasks: Array<{ title: string; description: string }> = []

  // Find the Step-by-Step Plan section
  const planSectionMatch = markdown.match(/##\s+Step-by-Step Plan\s*\n([\s\S]*?)(?:\n##|\n---|\s*$)/)
  if (!planSectionMatch) {
    // Fallback: look for any numbered list
    const lines = markdown.split('\n')
    for (const line of lines) {
      const m = line.match(/^\s*\d+\.\s+(.+)/)
      if (m) tasks.push({ title: m[1].trim(), description: m[1].trim() })
    }
    return tasks
  }

  const planSection = planSectionMatch[1]
  const lines = planSection.split('\n')
  let currentTask: { title: string; descLines: string[] } | null = null

  for (const line of lines) {
    const stepMatch = line.match(/^\s*(\d+)\.\s+(.+)/)
    if (stepMatch) {
      if (currentTask) {
        tasks.push({
          title: currentTask.title,
          description: [currentTask.title, ...currentTask.descLines].join('\n').trim(),
        })
      }
      currentTask = { title: stepMatch[2].trim(), descLines: [] }
    } else if (currentTask && line.trim()) {
      currentTask.descLines.push(line.trim())
    }
  }

  if (currentTask) {
    tasks.push({
      title: currentTask.title,
      description: [currentTask.title, ...currentTask.descLines].join('\n').trim(),
    })
  }

  return tasks
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill()
      resolve({ stdout, stderr, code: 124 })
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}

export async function POST(req: NextRequest, { params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // Build the goal string from project fields
  const goalParts = [project.name]
  if ((project as any).summary) goalParts.push((project as any).summary)
  if (project.description) goalParts.push(project.description)
  const featuresArr = (project as any).features as string[] | undefined
  if (featuresArr?.length) goalParts.push(`Features: ${featuresArr.join(', ')}`)
  const constraintsArr = (project as any).constraints as string[] | undefined
  if (constraintsArr?.length) goalParts.push(`Constraints: ${constraintsArr.join(', ')}`)
  goalParts.push(`Stack: ${project.stack}`)
  const goal = goalParts.join('. ')

  let tmpDir: string | null = null

  try {
    // Create temp directory and init git (required by planforge)
    tmpDir = await mkdtemp(join(tmpdir(), 'pf-'))
    await runCommand('git', ['init', '--quiet'], tmpDir)

    // Write planforge.json config
    const pfConfig = {
      planner: { provider: 'claude', model: 'claude-haiku-4-5' },
    }
    await writeFile(join(tmpDir, 'planforge.json'), JSON.stringify(pfConfig, null, 2))

    // Run planforge plan
    const { code, stderr } = await runCommand(
      'npx', ['--yes', 'planforge', 'plan', goal],
      tmpDir,
      120_000
    )

    if (code !== 0) {
      return NextResponse.json(
        { error: `planforge exited with code ${code}`, details: stderr.slice(0, 500) },
        { status: 502 }
      )
    }

    // Read the generated plan file
    const indexPath = join(tmpDir, '.cursor', 'plans', 'index.json')
    if (!existsSync(indexPath)) {
      return NextResponse.json({ error: 'planforge did not produce a plan file' }, { status: 502 })
    }

    const index = JSON.parse(await readFile(indexPath, 'utf-8')) as { activePlan?: string }
    if (!index.activePlan) {
      return NextResponse.json({ error: 'No activePlan in planforge index' }, { status: 502 })
    }

    const planPath = join(tmpDir, '.cursor', 'plans', index.activePlan)
    const planContent = await readFile(planPath, 'utf-8')

    // Parse to tasks
    const parsedTasks = parsePlanToTasks(planContent)
    if (parsedTasks.length === 0) {
      return NextResponse.json({ error: 'Could not parse tasks from plan', plan: planContent.slice(0, 500) }, { status: 422 })
    }

    // Save tasks to DB
    const created = await prisma.$transaction(
      parsedTasks.map((t, i) =>
        prisma.task.create({
          data: {
            projectId: project.id,
            title: t.title.slice(0, 200),
            description: t.description.slice(0, 2000),
            type: 'PLAN',
            wave: 1,
            order: i + 1,
            status: 'PENDING',
          },
        })
      )
    )

    // Update project status
    await prisma.project.update({
      where: { id },
      data: { status: 'PLANNING' },
    })

    // Log action
    await prisma.agentAction.create({
      data: {
        projectId: project.id,
        agentId: 'planforge',
        action: 'plan_generated',
        content: JSON.stringify({
          taskCount: created.length,
          goal: goal.slice(0, 200),
        }),
      },
    })

    return NextResponse.json({ tasks: created, plan: planContent })
  } catch (err) {
    console.error('[plan] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    // Cleanup temp dir
    if (tmpDir) {
      try { await rm(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
