import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createRepo, getInstallationToken } from '@/lib/github-app'
import { readFile, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative } from 'path'

interface Props { params: Promise<{ id: string }> }

/** Recursively collect all files in a directory */
async function collectFiles(dir: string): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...await collectFiles(fullPath))
    } else {
      try {
        const content = await readFile(fullPath, 'utf-8')
        result.push({ path: relative(dir, fullPath), content })
      } catch { /* skip binary files */ }
    }
  }
  return result
}

/**
 * Push a tree of files to GitHub via the Git Data API (no local git needed).
 * Uses: create blobs → create tree → create commit → update ref
 */
async function pushInitialCommit(params: {
  owner: string
  repo: string
  token: string
  files: Array<{ path: string; content: string }>
  message: string
  defaultBranch: string
}) {
  const { owner, repo, token, files, message, defaultBranch } = params
  const base = `https://api.github.com/repos/${owner}/${repo}`
  const headers: HeadersInit = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  // 1. Get latest commit SHA
  const refRes = await fetch(`${base}/git/refs/heads/${defaultBranch}`, { headers })
  if (!refRes.ok) throw new Error(`Failed to get ref: ${refRes.status}`)
  const refData = await refRes.json() as { object: { sha: string } }
  const latestSha = refData.object.sha

  // 2. Get base tree SHA
  const commitRes = await fetch(`${base}/git/commits/${latestSha}`, { headers })
  if (!commitRes.ok) throw new Error(`Failed to get commit: ${commitRes.status}`)
  const commitData = await commitRes.json() as { tree: { sha: string } }
  const baseTreeSha = commitData.tree.sha

  // 3. Create blobs for all files
  const treeItems = await Promise.all(files.map(async (f) => {
    const blobRes = await fetch(`${base}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    })
    if (!blobRes.ok) throw new Error(`Failed to create blob for ${f.path}: ${blobRes.status}`)
    const blob = await blobRes.json() as { sha: string }
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha }
  }))

  // 4. Create tree
  const treeRes = await fetch(`${base}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  })
  if (!treeRes.ok) throw new Error(`Failed to create tree: ${treeRes.status}`)
  const treeData = await treeRes.json() as { sha: string }

  // 5. Create commit
  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, tree: treeData.sha, parents: [latestSha] }),
  })
  if (!newCommitRes.ok) throw new Error(`Failed to create commit: ${newCommitRes.status}`)
  const newCommit = await newCommitRes.json() as { sha: string }

  // 6. Update ref
  const updateRes = await fetch(`${base}/git/refs/heads/${defaultBranch}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommit.sha }),
  })
  if (!updateRes.ok) throw new Error(`Failed to update ref: ${updateRes.status}`)

  return newCommit.sha
}

export async function POST(req: NextRequest, { params }: Props) {
  const { id } = await params

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const scaffoldDir = (project as any).scaffoldOutDir as string | null
  if (!scaffoldDir || !existsSync(scaffoldDir)) {
    return NextResponse.json({ error: 'No scaffold data — run scaffold first' }, { status: 400 })
  }

  let body: { repoName?: string } = {}
  try { body = await req.json() } catch { /* no body */ }

  const repoName = body.repoName?.trim()
    || project.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

  try {
    // 1. Create GitHub repository
    const { fullName, htmlUrl, cloneUrl, defaultBranch } = await createRepo({
      name: repoName,
      description: project.description.slice(0, 200),
      private: false,
    })

    // 2. Get installation token for Git API calls
    const { token } = await getInstallationToken()
    const [owner, repoSlug] = fullName.split('/')

    // 3. Collect scaffolded files
    const files = await collectFiles(scaffoldDir)

    // 4. Push initial commit
    const commitSha = await pushInitialCommit({
      owner,
      repo: repoSlug,
      token,
      files,
      message: `feat: initial scaffold\n\nGenerated by project-forge for "${project.name}"`,
      defaultBranch,
    })

    // 5. Update project in DB + clear scaffoldOutDir
    await prisma.project.update({
      where: { id },
      data: {
        status: 'PLANNING',
        githubRepo: fullName,
        githubUrl: htmlUrl,
        scaffoldOutDir: null,
      } as any,
    })

    // 6. Cleanup: remove temp scaffold directory (Task 011)
    try {
      await rm(scaffoldDir, { recursive: true, force: true })
    } catch (cleanupErr) {
      console.warn('[create-repo] Failed to cleanup scaffoldDir:', cleanupErr)
    }

    // 7. Log action
    await prisma.agentAction.create({
      data: {
        projectId: project.id,
        agentId: 'system',
        action: 'repo_created',
        content: JSON.stringify({
          repo: fullName,
          htmlUrl,
          cloneUrl,
          defaultBranch,
          commitSha,
          fileCount: files.length,
        }),
      },
    })

    return NextResponse.json({ repo: fullName, htmlUrl, cloneUrl, commitSha })
  } catch (err) {
    console.error('[create-repo] error:', err)

    // Log failure
    await prisma.agentAction.create({
      data: {
        projectId: project.id,
        agentId: 'system',
        action: 'repo_create_failed',
        content: JSON.stringify({ error: String(err) }),
      },
    }).catch(() => { /* ignore */ })

    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
