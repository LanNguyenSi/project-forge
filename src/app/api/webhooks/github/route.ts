import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/github-app'
import { prisma } from '@/lib/prisma'
import { broadcastToProject } from '@/lib/sse'

export async function POST(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get('x-hub-signature-256') ?? ''
  const event = request.headers.get('x-github-event') ?? ''

  const isValid = await verifyWebhookSignature(body, signature)
  if (!isValid) {
    console.warn('[webhook/github] Invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    switch (event) {
      case 'pull_request':
        await handlePullRequestEvent(payload)
        break
      case 'check_suite':
        await handleCheckSuiteEvent(payload)
        break
      case 'check_run':
        // Individual check run — handled by check_suite aggregate
        break
      default:
        break
    }
  } catch (error) {
    console.error(`[webhook/github] Error handling ${event}:`, error)
    return NextResponse.json({ ok: false, error: String(error) })
  }

  return NextResponse.json({ ok: true })
}

async function handlePullRequestEvent(payload: any) {
  const prNumber: number = payload.pull_request.number
  const action: string = payload.action
  const repoFullName: string = payload.repository.full_name

  const task = await prisma.task.findFirst({
    where: { prNumber, project: { githubRepo: repoFullName } },
    include: { project: true },
  })
  if (!task) return

  if (action === 'closed' && payload.pull_request.merged) {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'MERGED' },
    })

    await prisma.agentAction.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        agentId: 'system',
        action: 'pr_merged',
        content: JSON.stringify({
          prNumber,
          message: `PR #${prNumber} merged`,
        }),
      },
    })

    broadcastToProject(task.projectId, {
      type: 'task_status_changed',
      data: { ...task, status: 'MERGED' } as any,
      timestamp: new Date().toISOString(),
    })

    await checkWaveCompletion(task.projectId)
  }
}

async function handleCheckSuiteEvent(payload: any) {
  const { action, check_suite } = payload
  if (action !== 'completed') return

  const conclusion = check_suite.conclusion as string
  const headBranch = check_suite.head_branch as string
  const repoFullName = payload.repository.full_name

  const task = await prisma.task.findFirst({
    where: {
      branchName: headBranch,
      project: { githubRepo: repoFullName },
      status: 'IN_REVIEW',
    },
    include: { project: true },
  })
  if (!task) return

  const isPassed = conclusion === 'success'

  await prisma.agentAction.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      agentId: 'system',
      action: isPassed ? 'ci_passed' : 'ci_failed',
      content: JSON.stringify({
        branch: headBranch,
        conclusion,
        message: `CI ${isPassed ? 'passed ✅' : 'failed ❌'}`,
      }),
    },
  })

  broadcastToProject(task.projectId, {
    type: 'agent_action',
    data: {
      id: 'webhook-tmp',
      projectId: task.projectId,
      taskId: task.id,
      agentId: 'system',
      action: isPassed ? 'ci_passed' : 'ci_failed',
      content: JSON.stringify({ message: `CI ${isPassed ? 'passed' : 'failed'}` }),
      timestamp: new Date().toISOString(),
    } as any,
    timestamp: new Date().toISOString(),
  })
}

async function checkWaveCompletion(projectId: string) {
  const allTasks = await prisma.task.findMany({
    where: { projectId },
    orderBy: [{ wave: 'asc' }, { order: 'asc' }],
  })

  if (allTasks.length === 0) return

  const pendingTasks = allTasks.filter(t => t.status !== 'MERGED')
  if (pendingTasks.length === 0) {
    // All tasks merged — project is done!
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'DONE' },
    })
    await prisma.agentAction.create({
      data: {
        projectId,
        agentId: 'system',
        action: 'project_done',
        content: JSON.stringify({ message: '🎉 All tasks completed!' }),
      },
    })
    broadcastToProject(projectId, {
      type: 'project_status_changed',
      data: { id: projectId, status: 'DONE' } as any,
      timestamp: new Date().toISOString(),
    })
  }
}
