import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mcp } from '@/lib/ops-mcp'
import type { CreateProjectRequest } from '@/lib/types'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') ?? '20')
  const offset = parseInt(searchParams.get('offset') ?? '0')

  const where = status ? { status: status as any } : {}

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        tasks: {
          select: { id: true, status: true, wave: true },
        },
        _count: { select: { tasks: true } },
      },
    }),
    prisma.project.count({ where }),
  ])

  return NextResponse.json({ projects, total })
}

export async function POST(request: NextRequest) {
  let body: CreateProjectRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { name, description, stack, targetRepo } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }
  if (!stack?.trim()) {
    return NextResponse.json({ error: 'stack is required' }, { status: 400 })
  }

  const project = await prisma.project.create({
    data: {
      name: name.trim(),
      description: description.trim(),
      stack: stack.trim(),
      githubRepo: targetRepo?.trim() || null,
      status: 'PENDING',
    },
  })

  // Log initial action
  await prisma.agentAction.create({
    data: {
      projectId: project.id,
      agentId: 'system',
      action: 'project_created',
      content: JSON.stringify({
        message: `Project "${project.name}" created`,
        stack: project.stack,
        targetRepo: project.githubRepo,
      }),
    },
  })

  // Signal Ice via ops-mcp (non-fatal)
  try {
    await mcp.set(
      `pf:new:${project.id}`,
      JSON.stringify({
        projectId: project.id,
        name: project.name,
        description: project.description,
        stack: project.stack,
        targetRepo: project.githubRepo,
        createdAt: project.createdAt.toISOString(),
      })
    )
  } catch (err) {
    console.warn('[projects] Failed to signal Ice via ops-mcp:', err)
  }

  return NextResponse.json({ project }, { status: 201 })
}
