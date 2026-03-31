import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { registerConnection, unregisterConnection } from '@/lib/sse'

interface Props {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, { params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      registerConnection(id, controller)

      // Initial heartbeat
      controller.enqueue(encoder.encode(': heartbeat\n\n'))

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 30_000)

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        unregisterConnection(id, controller)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
