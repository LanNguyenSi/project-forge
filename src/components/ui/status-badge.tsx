import { clsx } from 'clsx'
import type { ProjectStatus, TaskStatus } from '@/lib/types'

type Status = ProjectStatus | TaskStatus

const STATUS_CONFIG: Record<Status, { label: string; classes: string }> = {
  PENDING:            { label: 'Pending',             classes: 'bg-zinc-800 text-zinc-400' },
  PLANNING:           { label: 'Planning',            classes: 'bg-blue-950 text-blue-300' },
  IMPLEMENTING:       { label: 'Implementing',        classes: 'bg-amber-950 text-amber-300' },
  REVIEWING:          { label: 'Reviewing',           classes: 'bg-purple-950 text-purple-300' },
  DONE:               { label: 'Done',                classes: 'bg-green-950 text-green-300' },
  FAILED:             { label: 'Failed',              classes: 'bg-red-950 text-red-300' },
  IN_PROGRESS:        { label: 'In Progress',         classes: 'bg-amber-950 text-amber-300' },
  IN_REVIEW:          { label: 'In Review',           classes: 'bg-purple-950 text-purple-300' },
  CHANGES_REQUESTED:  { label: 'Changes Requested',   classes: 'bg-orange-950 text-orange-300' },
  APPROVED:           { label: 'Approved',            classes: 'bg-emerald-950 text-emerald-300' },
  MERGED:             { label: 'Merged',              classes: 'bg-green-950 text-green-300' },
}

export function StatusBadge({ status }: { status: Status }) {
  const config = STATUS_CONFIG[status] ?? { label: status, classes: 'bg-zinc-800 text-zinc-400' }
  return (
    <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', config.classes)}>
      {config.label}
    </span>
  )
}
