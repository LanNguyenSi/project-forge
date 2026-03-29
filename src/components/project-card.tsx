import Link from 'next/link'
import { StatusBadge } from './ui/status-badge'
import type { Project, Task } from '@/lib/types'

interface Props {
  project: Project & { tasks: Pick<Task, 'id' | 'status' | 'wave'>[] }
}

export function ProjectCard({ project }: Props) {
  const merged = project.tasks.filter(t => t.status === 'MERGED').length
  const total = project.tasks.length

  return (
    <Link
      href={`/projects/${project.id}`}
      className="block bg-zinc-900 border border-zinc-800 rounded-xl p-5 hover:border-zinc-600 transition-colors"
    >
      <div className="flex items-start justify-between mb-3">
        <h2 className="font-semibold text-zinc-100">{project.name}</h2>
        <StatusBadge status={project.status as any} />
      </div>
      <p className="text-zinc-400 text-sm line-clamp-2 mb-4">{project.description}</p>
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="font-mono">{project.stack}</span>
        {total > 0 && <span>{merged}/{total} tasks</span>}
      </div>
    </Link>
  )
}
