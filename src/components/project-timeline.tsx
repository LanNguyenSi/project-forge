'use client'

import { useEffect, useRef } from 'react'
import { useProjectEvents } from '@/hooks/use-project-events'
import type { AgentAction } from '@/lib/types'

interface Props {
  projectId: string
  initialActions: AgentAction[]
}

const ACTION_LABELS: Record<string, string> = {
  project_created:      '⚒️  Project created',
  planning_started:     '🧊 Ice started planning',
  planning_in_progress: '💭 Analyzing description',
  task_created:         '📋 Task created',
  planning_complete:    '✅ Planning complete',
  repo_creating:        '📦 Creating GitHub repo',
  repo_created:         '📦 GitHub repo created',
  repo_exists:          '📦 Using existing repo',
  task_claimed:         '🤝 Task claimed',
  branch_creating:      '🌿 Creating branch',
  branch_created:       '🌿 Branch created',
  coding_started:       '🔥 Writing code',
  commit:               '💾 Code committed',
  pr_opening:           '🔀 Opening PR',
  pr_opened:            '🔀 PR opened',
  review_started:       '🧊 Ice started review',
  pr_approved:          '✅ PR approved',
  pr_merged:            '🎉 PR merged',
  changes_requested:    '✏️  Changes requested',
  addressing_changes:   '🔧 Addressing feedback',
  changes_pushed:       '✅ Changes pushed',
  ci_passed:            '✅ CI passed',
  ci_failed:            '❌ CI failed',
  task_failed:          '💥 Task failed',
  task_retry:           '🔄 Retrying task',
  escalation_needed:    '🚨 Needs human attention',
  project_done:         '🎊 Project complete!',
  project_status_changed: '📊 Status updated',
  wave_advanced:        '🚀 Next wave started',
}

function ActionRow({ action }: { action: AgentAction }) {
  const label = ACTION_LABELS[action.action] ?? `[${action.action}]`
  let content: { message?: string } | null = null
  try {
    if (action.content) content = JSON.parse(action.content)
  } catch {
    // ignore
  }

  return (
    <div className="flex items-start gap-3 py-2">
      <span className="text-xs text-zinc-500 font-mono whitespace-nowrap pt-0.5 flex-shrink-0">
        {new Date(action.timestamp).toLocaleTimeString()}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-300">{label}</p>
        {content?.message && (
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{content.message}</p>
        )}
      </div>
    </div>
  )
}

export function ProjectTimeline({ projectId, initialActions }: Props) {
  const { actions } = useProjectEvents(projectId, initialActions)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [actions.length])

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-300">Activity</h3>
      </div>
      <div className="px-4 py-2 max-h-80 overflow-y-auto divide-y divide-zinc-800">
        {actions.length === 0 ? (
          <p className="text-zinc-500 text-sm py-4 text-center">Waiting for activity…</p>
        ) : (
          actions.map(action => (
            <ActionRow key={action.id} action={action} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
