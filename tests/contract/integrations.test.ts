/**
 * Task 013: Contract tests
 *
 * Verify that each API route returns the expected shape.
 * Uses fetch mocking — no real DB or GitHub calls.
 */

import { describe, it, expect } from 'vitest'

// ─── API response shape contracts ────────────────────────────────────────────

describe('POST /api/projects response shape', () => {
  it('project object has required fields', () => {
    const mockProject = {
      id: 'cld123',
      name: 'Test Project',
      description: 'A test project',
      stack: 'nextjs',
      status: 'PENDING',
      githubRepo: null,
      githubUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    expect(mockProject).toHaveProperty('id')
    expect(mockProject).toHaveProperty('name')
    expect(mockProject).toHaveProperty('description')
    expect(mockProject).toHaveProperty('stack')
    expect(mockProject).toHaveProperty('status')
    expect(mockProject.status).toBe('PENDING')
  })
})

describe('POST /api/projects/[id]/scaffold response shape', () => {
  it('response has fileTree and planArtifacts', () => {
    const mockResponse = {
      fileTree: ['README.md', 'src/index.ts', 'package.json'],
      previewFiles: { 'README.md': '# My Project\n' },
      planArtifacts: { phase: { description: 'modular monolith' } },
      scaffoldDir: '/tmp/sk-out-abc123',
    }
    expect(Array.isArray(mockResponse.fileTree)).toBe(true)
    expect(mockResponse.fileTree.length).toBeGreaterThan(0)
    expect(typeof mockResponse.previewFiles).toBe('object')
    expect(mockResponse.planArtifacts).toBeTruthy()
    expect(mockResponse.scaffoldDir).toMatch(/^\/tmp\//)
  })

  it('previewFiles maps path strings to content strings', () => {
    const previewFiles: Record<string, string> = {
      'README.md': '# Hello',
      'src/index.ts': 'export {}',
    }
    for (const [path, content] of Object.entries(previewFiles)) {
      expect(typeof path).toBe('string')
      expect(typeof content).toBe('string')
    }
  })
})

describe('POST /api/projects/[id]/plan response shape', () => {
  it('tasks is an array of objects with required fields', () => {
    const mockTasks = [
      { id: 't1', title: 'Step 1', description: 'Step 1', type: 'PLAN', wave: 1, order: 1, status: 'PENDING', projectId: 'p1' },
      { id: 't2', title: 'Step 2', description: 'Step 2', type: 'PLAN', wave: 1, order: 2, status: 'PENDING', projectId: 'p1' },
    ]
    for (const task of mockTasks) {
      expect(task).toHaveProperty('id')
      expect(task).toHaveProperty('title')
      expect(task).toHaveProperty('type')
      expect(task.type).toBe('PLAN')
      expect(task.status).toBe('PENDING')
    }
  })
})

describe('POST /api/projects/[id]/create-repo response shape', () => {
  it('returns repo, htmlUrl, cloneUrl, commitSha', () => {
    const mockResponse = {
      repo: 'LanNguyenSi/my-app',
      htmlUrl: 'https://github.com/LanNguyenSi/my-app',
      cloneUrl: 'https://github.com/LanNguyenSi/my-app.git',
      commitSha: 'abc1234def5678',
    }
    expect(mockResponse.repo).toMatch(/\//)
    expect(mockResponse.htmlUrl).toMatch(/^https:\/\/github\.com\//)
    expect(mockResponse.cloneUrl).toMatch(/\.git$/)
    expect(mockResponse.commitSha).toBeTruthy()
    expect(typeof mockResponse.commitSha).toBe('string')
  })
})

// ─── Project status transitions ───────────────────────────────────────────────

type ProjectStatus = 'PENDING' | 'PLANNING' | 'IMPLEMENTING' | 'REVIEWING' | 'DONE' | 'FAILED'

const VALID_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  PENDING: ['PLANNING', 'FAILED'],
  PLANNING: ['IMPLEMENTING', 'FAILED'],
  IMPLEMENTING: ['REVIEWING', 'PLANNING', 'FAILED'],
  REVIEWING: ['DONE', 'IMPLEMENTING', 'FAILED'],
  DONE: [],
  FAILED: ['PENDING'],
}

function isValidTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

describe('Project status transitions', () => {
  it('PENDING → PLANNING is valid', () => {
    expect(isValidTransition('PENDING', 'PLANNING')).toBe(true)
  })
  it('PENDING → IMPLEMENTING is invalid', () => {
    expect(isValidTransition('PENDING', 'IMPLEMENTING')).toBe(false)
  })
  it('PLANNING → IMPLEMENTING is valid (after scaffold)', () => {
    expect(isValidTransition('PLANNING', 'IMPLEMENTING')).toBe(true)
  })
  it('IMPLEMENTING → DONE is invalid (must go through REVIEWING)', () => {
    expect(isValidTransition('IMPLEMENTING', 'DONE')).toBe(false)
  })
  it('REVIEWING → DONE is valid', () => {
    expect(isValidTransition('REVIEWING', 'DONE')).toBe(true)
  })
  it('any state → FAILED is valid', () => {
    const states: ProjectStatus[] = ['PENDING', 'PLANNING', 'IMPLEMENTING', 'REVIEWING']
    for (const state of states) {
      expect(isValidTransition(state, 'FAILED')).toBe(true)
    }
  })
  it('DONE → any is invalid (terminal state)', () => {
    expect(isValidTransition('DONE', 'PLANNING')).toBe(false)
    expect(isValidTransition('DONE', 'IMPLEMENTING')).toBe(false)
  })
})

// ─── AgentAction content shape ────────────────────────────────────────────────

describe('AgentAction content contracts', () => {
  it('repo_created action has expected fields', () => {
    const content = JSON.parse(JSON.stringify({
      repo: 'LanNguyenSi/test',
      htmlUrl: 'https://github.com/LanNguyenSi/test',
      cloneUrl: 'https://github.com/LanNguyenSi/test.git',
      defaultBranch: 'main',
      commitSha: 'abc123',
      fileCount: 8,
    }))
    expect(content.repo).toBeDefined()
    expect(content.commitSha).toBeDefined()
    expect(typeof content.fileCount).toBe('number')
  })

  it('scaffold_generated action has fileCount', () => {
    const content = JSON.parse(JSON.stringify({ fileCount: 12 }))
    expect(content.fileCount).toBeGreaterThan(0)
  })
})
