import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'

interface Props { params: Promise<{ id: string }> }

export const dynamic = 'force-dynamic'

export default async function SuccessPage({ params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      tasks: { orderBy: [{ wave: 'asc' }, { order: 'asc' }] },
      actions: { orderBy: { timestamp: 'desc' }, take: 1 },
    },
  })

  if (!project) notFound()

  const repoAction = project.actions.find(a => a.action === 'repo_created')
  const repoDetails = repoAction?.content
    ? (() => { try { return JSON.parse(repoAction.content as string) } catch { return null } })()
    : null

  const pendingTasks = project.tasks.filter(t => t.status === 'PENDING').length
  const totalTasks = project.tasks.length

  return (
    <div className="max-w-2xl">
      {/* Hero */}
      <div className="text-center py-12 mb-8">
        <div className="text-6xl mb-4">🎉</div>
        <h1 className="text-3xl font-bold mb-2">Repository Created!</h1>
        <p className="text-zinc-400 text-sm">
          <span className="font-mono text-zinc-300">{project.githubRepo ?? project.name}</span> is live on GitHub.
        </p>
      </div>

      {/* Repo card */}
      {project.githubUrl && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-zinc-500 mb-0.5">Repository</p>
              <p className="font-mono text-zinc-200 font-medium">{project.githubRepo}</p>
            </div>
            <a
              href={project.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-2 rounded-md text-sm transition-colors flex items-center gap-2"
            >
              Open on GitHub ↗
            </a>
          </div>
          {repoDetails?.commitSha && (
            <p className="text-xs text-zinc-600 mt-3 font-mono">
              Initial commit: <span className="text-zinc-500">{(repoDetails.commitSha as string).slice(0, 7)}</span>
              {' · '}{repoDetails.fileCount} file{repoDetails.fileCount !== 1 ? 's' : ''} pushed
            </p>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        {[
          { label: 'Files pushed', value: repoDetails?.fileCount ?? '—' },
          { label: 'Total tasks', value: totalTasks },
          { label: 'Pending', value: pendingTasks },
        ].map((stat) => (
          <div key={stat.label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-zinc-200">{stat.value}</p>
            <p className="text-xs text-zinc-500 mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Next steps */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-8">
        <h2 className="text-sm font-semibold text-zinc-300 mb-4">What happens next</h2>
        <div className="space-y-3">
          <div className="flex gap-3 text-sm">
            <span className="text-indigo-400 shrink-0">→</span>
            <p className="text-zinc-400">
              <span className="text-zinc-200 font-medium">Ice</span> will plan the {totalTasks} tasks and assign them to agents.
            </p>
          </div>
          <div className="flex gap-3 text-sm">
            <span className="text-indigo-400 shrink-0">→</span>
            <p className="text-zinc-400">
              <span className="text-zinc-200 font-medium">Lava</span> will implement each task in a branch and open PRs.
            </p>
          </div>
          <div className="flex gap-3 text-sm">
            <span className="text-indigo-400 shrink-0">→</span>
            <p className="text-zinc-400">
              Watch progress on the project page. Each PR merge updates the task status.
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <Link
          href={`/projects/${id}`}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-md text-sm font-medium transition-colors"
        >
          View Project →
        </Link>
        {project.githubUrl && (
          <a
            href={project.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-md text-sm transition-colors"
          >
            Open GitHub ↗
          </a>
        )}
        <Link
          href="/projects/new"
          className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-md text-sm transition-colors"
        >
          + New Project
        </Link>
      </div>
    </div>
  )
}
