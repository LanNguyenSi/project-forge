import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { broadcastToProject } from '@/lib/sse'

interface Props {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, { params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      tasks: {
        orderBy: [{ wave: 'asc' }, { order: 'asc' }],
      },
      actions: {
        orderBy: { timestamp: 'desc' },
        take: 100,
      },
    },
  })

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  return NextResponse.json({ project })
}

export async function PATCH(request: NextRequest, { params }: Props) {
  const { id } = await params

  const agentId = request.headers.get('x-agent-id')
  const allowed = (process.env.AGENT_IDS ?? 'ice,lava').split(',').map(s => s.trim())
  if (!agentId || !allowed.includes(agentId)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const allowedFields = ['status', 'githubRepo', 'githubUrl']
  const updates: Record<string, any> = {}
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const project = await prisma.project.update({
    where: { id },
    data: updates,
  })

  if (updates.status) {
    broadcastToProject(id, {
      type: 'project_status_changed',
      data: project as any,
      timestamp: new Date().toISOString(),
    })
  }

  return NextResponse.json({ project })
}
