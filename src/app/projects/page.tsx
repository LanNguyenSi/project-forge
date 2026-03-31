import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import { ProjectCard } from '@/components/project-card'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      tasks: {
        select: { id: true, status: true, wave: true },
      },
    },
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-zinc-400 text-sm mt-1">
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-md text-sm transition-colors"
        >
          + New Project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="text-center py-24 border border-dashed border-zinc-800 rounded-xl">
          <div className="text-4xl mb-4">⚒️</div>
          <h2 className="text-lg font-medium text-zinc-300 mb-2">No projects yet</h2>
          <p className="text-zinc-500 text-sm mb-6">
            Create your first project and let Ice + Lava build it.
          </p>
          <Link
            href="/projects/new"
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-md text-sm"
          >
            + New Project
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={{
                ...project,
                status: project.status as any,
                createdAt: project.createdAt.toISOString(),
                updatedAt: project.updatedAt.toISOString(),
                tasks: project.tasks as any,
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
