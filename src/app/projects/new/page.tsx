'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const STACKS = [
  { value: 'nextjs', label: 'Next.js (React + API)' },
  { value: 'express', label: 'Express.js (Node API)' },
  { value: 'fastapi', label: 'FastAPI (Python)' },
  { value: 'react', label: 'React (frontend only)' },
  { value: 'other', label: 'Other' },
]

export default function NewProjectPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    description: '',
    stack: 'nextjs',
    targetRepo: '',
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          description: form.description,
          stack: form.stack,
          ...(form.targetRepo ? { targetRepo: form.targetRepo } : {}),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create project')
      }

      const { project } = await res.json()
      router.push(`/projects/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">New Project</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Describe what you want to build. Ice will plan it, Lava will build it.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Project Name
          </label>
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="my-awesome-app"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Description
          </label>
          <textarea
            required
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={5}
            placeholder="Build a REST API for a todo app with user authentication, CRUD operations, and PostgreSQL storage..."
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
          />
          <p className="text-zinc-500 text-xs mt-1">
            Be specific. Ice will use this to create a detailed task plan.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Stack
          </label>
          <select
            value={form.stack}
            onChange={(e) => setForm({ ...form, stack: e.target.value })}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {STACKS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Target Repository (optional)
          </label>
          <input
            type="text"
            value={form.targetRepo}
            onChange={(e) => setForm({ ...form, targetRepo: e.target.value })}
            placeholder="LanNguyenSi/existing-repo"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="text-zinc-500 text-xs mt-1">
            Leave blank to let Ice create a new repo automatically.
          </p>
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 px-3 py-2 rounded-md text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-md text-sm font-medium transition-colors"
          >
            {loading ? 'Creating…' : 'Create Project'}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-md text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
