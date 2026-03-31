'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface Task { id: string; title: string; wave: number; order: number; status: string }
interface Project {
  id: string
  name: string
  description: string
  stack: string
  status: string
  githubRepo: string | null
  tasks: Task[]
}
interface ScaffoldData {
  fileTree: string[]
  planArtifacts: Record<string, unknown> | null
}

export default function ConfirmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [project, setProject] = useState<Project | null>(null)
  const [scaffold, setScaffold] = useState<ScaffoldData | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repoName, setRepoName] = useState('')
  const [agreed, setAgreed] = useState(false)

  useEffect(() => {
    void load()
  }, [id])

  async function load() {
    setLoading(true)
    try {
      const [projRes, scaffoldRes] = await Promise.all([
        fetch(`/api/projects/${id}`),
        fetch(`/api/projects/${id}/scaffold`),
      ])
      if (!projRes.ok) throw new Error('Project not found')
      const { project: proj } = await projRes.json() as { project: Project }
      setProject(proj)
      setRepoName(proj.githubRepo ?? proj.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
      if (scaffoldRes.ok) {
        setScaffold(await scaffoldRes.json() as ScaffoldData)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    if (!agreed) return
    setConfirming(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${id}/create-repo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoName }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      router.push(`/projects/${id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create repository')
      setConfirming(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-zinc-500 text-sm animate-pulse">Loading…</span>
      </div>
    )
  }

  if (!project) {
    return <div className="text-red-400 text-sm p-4">{error ?? 'Project not found'}</div>
  }

  const archShape = (scaffold?.planArtifacts as any)?.phase?.architecture?.shape ?? 'modular monolith'
  const pendingTasks = project.tasks.filter(t => t.status === 'PENDING')

  return (
    <div className="max-w-2xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-sm text-zinc-500 mb-1">
          <Link href={`/projects/${id}/preview`} className="hover:text-zinc-300 transition-colors">
            ← Preview
          </Link>
        </div>
        <h1 className="text-2xl font-bold">Confirm & Create Repository</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Review what will happen before any GitHub action is taken.
        </p>
      </div>

      {/* Summary card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-300">What will happen</h2>

        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-indigo-700/60 text-indigo-200 text-xs flex items-center justify-center shrink-0 font-medium">1</span>
            <div>
              <p className="text-zinc-200 font-medium">Create GitHub repository</p>
              <p className="text-zinc-500 text-xs mt-0.5">
                A new public repo <span className="font-mono text-zinc-400">{repoName}</span> will be created under your GitHub account.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-indigo-700/60 text-indigo-200 text-xs flex items-center justify-center shrink-0 font-medium">2</span>
            <div>
              <p className="text-zinc-200 font-medium">Initial commit with scaffolded files</p>
              <p className="text-zinc-500 text-xs mt-0.5">
                {scaffold?.fileTree.length ?? 0} file{(scaffold?.fileTree.length ?? 0) !== 1 ? 's' : ''} from scaffoldkit will be pushed as the first commit.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-indigo-700/60 text-indigo-200 text-xs flex items-center justify-center shrink-0 font-medium">3</span>
            <div>
              <p className="text-zinc-200 font-medium">Tasks created for agents</p>
              <p className="text-zinc-500 text-xs mt-0.5">
                {pendingTasks.length} pending task{pendingTasks.length !== 1 ? 's' : ''} will be queued for Ice & Lava to implement.
              </p>
            </div>
          </li>
        </ol>
      </div>

      {/* Project details */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold text-zinc-300 mb-3">Project details</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-zinc-500">Name</dt>
            <dd className="text-zinc-300">{project.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Stack</dt>
            <dd className="text-zinc-300 font-mono">{project.stack}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Architecture</dt>
            <dd className="text-zinc-300">{archShape}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Files</dt>
            <dd className="text-zinc-300">{scaffold?.fileTree.length ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Tasks</dt>
            <dd className="text-zinc-300">{project.tasks.length}</dd>
          </div>
        </dl>
      </div>

      {/* Confirm form */}
      <form onSubmit={handleConfirm} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Repository name
          </label>
          <input
            type="text"
            required
            value={repoName}
            onChange={e => setRepoName(e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-xs text-zinc-500 mt-1">Only lowercase letters, numbers, and hyphens.</p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={agreed}
            onChange={e => setAgreed(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer"
          />
          <span className="text-sm text-zinc-400 group-hover:text-zinc-300 transition-colors">
            I understand this will create a GitHub repository and push code. This action cannot be undone.
          </span>
        </label>

        {error && (
          <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={!agreed || confirming}
            className="bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-2 rounded-md text-sm font-medium transition-colors"
          >
            {confirming ? '⚙️ Creating…' : '✓ Confirm & Create Repository'}
          </button>
          <Link
            href={`/projects/${id}/preview`}
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-md text-sm transition-colors"
          >
            ← Back to Preview
          </Link>
        </div>
      </form>
    </div>
  )
}
