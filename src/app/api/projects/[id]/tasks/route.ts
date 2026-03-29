import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mcp } from '@/lib/ops-mcp'
import { broadcastToProject } from '@/lib/sse'
import type { CreateTaskRequest } from '@/lib/types'

interface Props {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, { params }: Props) {
  const { id } = await params
  const { searchParams } = new URL(request.url)
  const wave = searchParams.get('wave')
  const status = searchParams.get('status')

  const where: any = { projectId: id }
  if (wave) where.wave = parseInt(wave)
  if (status) where.status = status

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ wave: 'asc' }, { order: 'asc' }],
    include: {
      actions: {
        orderBy: { timestamp: 'desc' },
        take: 10,
      },
    },
  })

  return NextResponse.json({ tasks })
}

export async function POST(request: NextRequest, { params }: Props) {
  const { id } = await params

  const agentId = request.headers.get('x-agent-id')
  const allowed = (process.env.AGENT_IDS ?? 'ice,lava').split(',').map(s => s.trim())
  if (!agentId || !allowed.includes(agentId)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  let body: CreateTaskRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { title, description, type, wave, order } = body

  if (!title?.trim() || !description?.trim() || !type) {
    return NextResponse.json(
      { error: 'title, description, and type are required' },
      { status: 400 }
    )
  }

  const task = await prisma.task.create({
    data: {
      projectId: id,
      title: title.trim(),
      description: description.trim(),
      type,
      wave: wave ?? 1,
      order: order ?? 0,
      assignedAgent: type === 'IMPLEMENT' ? 'lava' : 'ice',
      status: 'PENDING',
    },
  })

  await prisma.agentAction.create({
    data: {
      projectId: id,
      taskId: task.id,
      agentId,
      action: 'task_created',
      content: JSON.stringify({
        title: task.title,
        type: task.type,
        wave: task.wave,
        message: `Task created: ${task.title}`,
      }),
    },
  })

  broadcastToProject(id, {
    type: 'task_created',
    data: task as any,
    timestamp: new Date().toISOString(),
  })

  // Add IMPLEMENT tasks to ops-mcp pending queue (non-fatal)
  if (type === 'IMPLEMENT') {
    try {
      const queueKey = 'pf:tasks:pending'
      const currentQueue = await mcp.get(queueKey)
      const queue: string[] = currentQueue ? JSON.parse(currentQueue) : []
      if (!queue.includes(task.id)) {
        queue.push(task.id)
        await mcp.set(queueKey, JSON.stringify(queue))
      }
    } catch (err) {
      console.warn('[tasks] Failed to add task to ops-mcp queue:', err)
    }
  }

  return NextResponse.json({ task }, { status: 201 })
}
