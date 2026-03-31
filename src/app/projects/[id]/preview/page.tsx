'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface Task {
  id: string
  title: string
  description: string
  status: string
  wave: number
  order: number
  type: string
}

interface ScaffoldData {
  fileTree: string[]
  previewFiles: Record<string, string>
  planArtifacts: Record<string, unknown> | null
}

interface Project {
  id: string
  name: string
  description: string
  status: string
  tasks: Task[]
}

function FileTreeItem({ path, selected, onClick }: { path: string; selected: boolean; onClick: () => void }) {
  const parts = path.split('/')
  const depth = parts.length - 1
  const name = parts[parts.length - 1]

  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-1.5 py-0.5 px-2 rounded text-xs transition-colors truncate ${
        selected
          ? 'bg-indigo-900/40 text-indigo-300'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
      }`}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span className="shrink-0">{depth > 0 ? '📄' : '📄'}</span>
      <span className="truncate">{name}</span>
    </button>
  )
}

export default function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [project, setProject] = useState<Project | null>(null)
  const [scaffold, setScaffold] = useState<ScaffoldData | null>(null)
  const [loading, setLoading] = useState(true)
  const [scaffolding, setScaffolding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'tasks' | 'architecture' | 'files'>('tasks')

  useEffect(() => {
    void load()
  }, [id])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [projRes, scaffoldRes] = await Promise.all([
        fetch(`/api/projects/${id}`),
        fetch(`/api/projects/${id}/scaffold`),
      ])

      if (!projRes.ok) throw new Error('Project not found')
      const projData = await projRes.json() as { project: Project }
      setProject(projData.project)

      if (scaffoldRes.ok) {
        const scaffoldData = await scaffoldRes.json() as ScaffoldData
        setScaffold(scaffoldData)
        if (scaffoldData.fileTree.length > 0) {
          setSelectedFile(scaffoldData.fileTree[0])
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function runScaffold() {
    setScaffolding(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${id}/scaffold`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as ScaffoldData
      setScaffold(data)
      if (data.fileTree.length > 0) setSelectedFile(data.fileTree[0])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scaffold failed')
    } finally {
      setScaffolding(false)
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
    return (
      <div className="text-red-400 text-sm p-4">Project not found</div>
    )
  }

  const architectureText = scaffold?.planArtifacts
    ? (scaffold.planArtifacts as any)?.phase?.description ?? JSON.stringify(scaffold.planArtifacts, null, 2).slice(0, 2000)
    : null

  return (
    <div className="max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-zinc-500 mb-1">
            <Link href={`/projects/${id}`} className="hover:text-zinc-300 transition-colors">
              ← {project.name}
            </Link>
          </div>
          <h1 className="text-2xl font-bold">Preview</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Generated tasks, architecture, and file tree
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!scaffold && (
            <button
              onClick={() => void runScaffold()}
              disabled={scaffolding}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
            >
              {scaffolding ? '⚙️ Running…' : '▶ Run Scaffold'}
            </button>
          )}
          {scaffold && (
            <>
              <button
                onClick={() => void runScaffold()}
                disabled={scaffolding}
                className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 px-4 py-2 rounded-md text-sm transition-colors"
              >
                {scaffolding ? '⚙️ Re-running…' : '↺ Re-generate'}
              </button>
              <Link
                href={`/projects/${id}/confirm`}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
              >
                Confirm & Create Repo →
              </Link>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-zinc-800 pb-0">
        {(['tasks', 'architecture', 'files'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg -mb-px transition-colors ${
              activeTab === tab
                ? 'bg-zinc-900 border border-b-zinc-900 border-zinc-800 text-white'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab === 'tasks' && `📋 Tasks (${project.tasks.length})`}
            {tab === 'architecture' && '🏛 Architecture'}
            {tab === 'files' && `📁 Files (${scaffold?.fileTree.length ?? 0})`}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'tasks' && (
        <div className="space-y-2">
          {project.tasks.length === 0 ? (
            <div className="text-zinc-500 text-sm py-8 text-center">
              No tasks yet — run the plan step first.
            </div>
          ) : (
            project.tasks.map((task) => (
              <div key={task.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-zinc-600 font-mono">W{task.wave}.{task.order}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        task.status === 'MERGED' ? 'bg-green-900/40 text-green-300' :
                        task.status === 'IN_PROGRESS' ? 'bg-blue-900/40 text-blue-300' :
                        'bg-zinc-800 text-zinc-400'
                      }`}>{task.status}</span>
                    </div>
                    <p className="text-sm font-medium text-zinc-200">{task.title}</p>
                    {task.description && task.description !== task.title && (
                      <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{task.description}</p>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'architecture' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          {architectureText ? (
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed overflow-auto max-h-[60vh]">
              {architectureText}
            </pre>
          ) : (
            <p className="text-zinc-500 text-sm">
              No architecture data yet — run scaffold to generate it.
            </p>
          )}
        </div>
      )}

      {activeTab === 'files' && (
        <div className="flex gap-4 h-[60vh]">
          {/* File tree */}
          <div className="w-64 shrink-0 bg-zinc-900 border border-zinc-800 rounded-xl overflow-y-auto py-2">
            {scaffold?.fileTree.length ? (
              scaffold.fileTree.map((path) => (
                <FileTreeItem
                  key={path}
                  path={path}
                  selected={selectedFile === path}
                  onClick={() => setSelectedFile(path)}
                />
              ))
            ) : (
              <p className="text-xs text-zinc-600 px-3 py-2">No files — run scaffold first.</p>
            )}
          </div>

          {/* File content */}
          <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
            {selectedFile ? (
              <>
                <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-500 font-mono shrink-0">
                  {selectedFile}
                </div>
                <pre className="flex-1 overflow-auto px-4 py-3 text-xs text-zinc-300 leading-relaxed">
                  {scaffold?.previewFiles?.[selectedFile] ?? '(content not available)'}
                </pre>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
                Select a file to preview
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
