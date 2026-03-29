import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="text-center py-24">
      <div className="text-4xl mb-4">🔍</div>
      <h2 className="text-lg font-medium text-zinc-300 mb-2">Project not found</h2>
      <p className="text-zinc-500 text-sm mb-6">
        This project doesn&apos;t exist or was deleted.
      </p>
      <Link
        href="/projects"
        className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-md text-sm"
      >
        ← Back to Projects
      </Link>
    </div>
  )
}
