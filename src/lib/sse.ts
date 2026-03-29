import type { SSEEvent } from './types'

// In-memory registry of SSE connections per project
const connections = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()

export function registerConnection(
  projectId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
) {
  if (!connections.has(projectId)) {
    connections.set(projectId, new Set())
  }
  connections.get(projectId)!.add(controller)
}

export function unregisterConnection(
  projectId: string,
  controller: ReadableStreamDefaultController<Uint8Array>
) {
  connections.get(projectId)?.delete(controller)
  if (connections.get(projectId)?.size === 0) {
    connections.delete(projectId)
  }
}

export function broadcastToProject(projectId: string, event: SSEEvent) {
  const projectConnections = connections.get(projectId)
  if (!projectConnections || projectConnections.size === 0) return

  const encoder = new TextEncoder()
  const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  const encoded = encoder.encode(data)

  const deadConnections: ReadableStreamDefaultController<Uint8Array>[] = []

  for (const controller of projectConnections) {
    try {
      controller.enqueue(encoded)
    } catch {
      deadConnections.push(controller)
    }
  }

  for (const dead of deadConnections) {
    projectConnections.delete(dead)
  }
}
