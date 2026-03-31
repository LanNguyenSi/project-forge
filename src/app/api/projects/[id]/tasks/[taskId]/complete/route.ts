import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mcp } from '@/lib/ops-mcp'
import { broadcastToProject } from '@/lib/sse'
import type { CompleteTaskRequest } from '@/lib/types'

interface Props {
  params: Promise<{ id: string; taskId: string }>
}

export async function POST(request: NextRequest, { params }: Props) {
  const { id, taskId } = await params

  const agentId = request.headers.get('x-agent-id')
  const allowed = (process.env.AGENT_IDS ?? 'ice,lava').split(',').map(s => s.trim())
  if (!agentId || !allowed.includes(agentId)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: id },
  })
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  }

  let body: CompleteTaskRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { result, prUrl, prNumber, branchName } = body

  // Determine next status
  let nextStatus: string
  if (task.type === 'IMPLEMENT' && agentId === 'lava') {
    nextStatus = 'IN_REVIEW'
  } else if (task.type === 'REVIEW' && agentId === 'ice') {
    nextStatus = 'MERGED'
  } else {
    nextStatus = 'MERGED'
  }

  const updatedTask = await prisma.task.update({
    where: { id: taskId },
    data: {
      status: nextStatus as any,
      ...(prUrl ? { prUrl } : {}),
      ...(prNumber ? { prNumber } : {}),
      ...(branchName ? { branchName } : {}),
      assignedAgent: agentId,
    },
  })

  const actionType =
    nextStatus === 'IN_REVIEW' ? 'pr_opened' :
    nextStatus === 'MERGED' ? 'pr_merged' : 'task_completed'

  await prisma.agentAction.create({
    data: {
      projectId: id,
      taskId,
      agentId,
      action: actionType,
      content: JSON.stringify({ result, prUrl, prNumber, branchName, message: result }),
    },
  })

  // Update ops-mcp (non-fatal)
  try {
    await mcp.del(`pf:task:${taskId}:lock`)
    await mcp.set(`pf:task:${taskId}:status`, nextStatus)

    if (nextStatus !== 'PENDING') {
      const queueKey = 'pf:tasks:pending'
      const currentQueue = await mcp.get(queueKey)
      if (currentQueue) {
        const queue: string[] = JSON.parse(currentQueue)
        const newQueue = queue.filter(tid => tid !== taskId)
        await mcp.set(queueKey, JSON.stringify(newQueue))
      }
    }

    if (nextStatus === 'IN_REVIEW' && prNumber) {
      const reviewQueueKey = 'pf:review:queue'
      const current = await mcp.get(reviewQueueKey)
      const queue: any[] = current ? JSON.parse(current) : []
      queue.push({ prNumber, taskId, projectId: id, ciStatus: 'pending', enqueuedAt: Date.now() })
      await mcp.set(reviewQueueKey, JSON.stringify(queue))
    }
  } catch (err) {
    console.warn('[complete] ops-mcp update failed:', err)
  }

  broadcastToProject(id, {
    type: 'task_status_changed',
    data: updatedTask as any,
    timestamp: new Date().toISOString(),
  })

  return NextResponse.json({ task: updatedTask })
}
