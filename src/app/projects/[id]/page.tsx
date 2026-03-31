import { notFound } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { ProjectTimeline } from '@/components/project-timeline'
import { TaskList } from '@/components/task-list'
import { StatusBadge } from '@/components/ui/status-badge'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function ProjectDetailPage({ params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      tasks: {
        orderBy: [{ wave: 'asc' }, { order: 'asc' }],
      },
      actions: {
        orderBy: { timestamp: 'desc' },
        take: 50,
      },
    },
  })

  if (!project) notFound()

  const totalTasks = project.tasks.length
  const mergedTasks = project.tasks.filter(t => t.status === 'MERGED').length
  const progressPct = totalTasks > 0 ? Math.round((mergedTasks / totalTasks) * 100) : 0

  const serializedProject = {
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    tasks: project.tasks.map(t => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    actions: project.actions.map(a => ({
      ...a,
      timestamp: a.timestamp.toISOString(),
    })),
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Link href="/projects" className="text-zinc-500 hover:text-zinc-300 text-sm">
                ← Projects
              </Link>
            </div>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <p className="text-zinc-400 text-sm mt-1 max-w-2xl">{project.description}</p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0 ml-4">
            <StatusBadge status={project.status} />
            {project.githubUrl && (
              <a
                href={project.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-400 hover:text-white border border-zinc-700 px-3 py-1.5 rounded-md transition-colors"
              >
                GitHub ↗
              </a>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {totalTasks > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
              <span>{mergedTasks} / {totalTasks} tasks merged</span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Tasks + Timeline */}
        <div className="xl:col-span-2 space-y-6">
          <TaskList tasks={serializedProject.tasks as any} />
          <ProjectTimeline
            projectId={project.id}
            initialActions={serializedProject.actions as any}
          />
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <h3 className="text-sm font-medium text-zinc-300 mb-3">Details</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Stack</dt>
                <dd className="text-zinc-300 font-mono">{project.stack}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Status</dt>
                <dd><StatusBadge status={project.status} /></dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-zinc-500">Created</dt>
                <dd className="text-zinc-300">
                  {new Date(project.createdAt).toLocaleDateString()}
                </dd>
              </div>
              {project.githubRepo && (
                <div className="flex justify-between items-center">
                  <dt className="text-zinc-500">Repo</dt>
                  <dd className="text-zinc-300 font-mono text-xs truncate max-w-[140px]">
                    {project.githubRepo}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
