'use client'

import { useEffect, useState } from 'react'
import type { AgentAction, SSEEvent } from '@/lib/types'

export function useProjectEvents(
  projectId: string,
  initialActions: AgentAction[]
) {
  const [actions, setActions] = useState<AgentAction[]>(initialActions)

  useEffect(() => {
    const eventSource = new EventSource(`/api/projects/${projectId}/events`)

    eventSource.addEventListener('agent_action', (e: MessageEvent) => {
      const event: SSEEvent = JSON.parse(e.data)
      setActions(prev => [event.data as AgentAction, ...prev])
    })

    eventSource.addEventListener('task_created', () => {
      // Reload to pick up new tasks from server
      window.location.reload()
    })

    eventSource.onerror = () => {
      // EventSource auto-reconnects on error
    }

    return () => eventSource.close()
  }, [projectId])

  return { actions }
}
