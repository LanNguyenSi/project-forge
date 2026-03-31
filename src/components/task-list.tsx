import { StatusBadge } from './ui/status-badge'
import type { Task } from '@/lib/types'

interface Props {
  tasks: Task[]
}

const AGENT_EMOJI: Record<string, string> = {
  ice: '🧊',
  lava: '🌋',
}

export function TaskList({ tasks }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center">
        <p className="text-zinc-500 text-sm">No tasks yet — Ice is planning...</p>
      </div>
    )
  }

  const waves = [...new Set(tasks.map(t => t.wave))].sort()

  return (
    <div className="space-y-4">
      {waves.map(wave => (
        <div key={wave} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
              Wave {wave}
            </span>
          </div>
          <div className="divide-y divide-zinc-800">
            {tasks
              .filter(t => t.wave === wave)
              .sort((a, b) => a.order - b.order)
              .map(task => (
                <div key={task.id} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {task.title}
                      </span>
                      {task.assignedAgent && (
                        <span className="text-sm" title={task.assignedAgent}>
                          {AGENT_EMOJI[task.assignedAgent] ?? '🤖'}
                        </span>
                      )}
                    </div>
                    {task.prUrl && (
                      <a
                        href={task.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-400 hover:text-indigo-300 mt-0.5 block"
                        onClick={e => e.stopPropagation()}
                      >
                        PR #{task.prNumber} ↗
                      </a>
                    )}
                  </div>
                  <StatusBadge status={task.status} />
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}
