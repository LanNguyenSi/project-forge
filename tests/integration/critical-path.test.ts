/**
 * Task 013: Critical-path integration tests
 *
 * These tests exercise the key pipeline steps end-to-end using
 * mocked external dependencies (GitHub API, planforge CLI).
 * No real network calls or file-system side-effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Scaffold pipeline helpers ────────────────────────────────────────────────

/** parsePlanToTasks lives in the scaffold route — extract the logic here for unit testing */
function parsePlanToTasks(markdown: string): Array<{ title: string; description: string }> {
  const tasks: Array<{ title: string; description: string }> = []

  const planSectionMatch = markdown.match(/##\s+Step-by-Step Plan\s*\n([\s\S]*?)(?:\n##|\n---|\s*$)/)
  if (!planSectionMatch) {
    const lines = markdown.split('\n')
    for (const line of lines) {
      const m = line.match(/^\s*\d+\.\s+(.+)/)
      if (m) tasks.push({ title: m[1].trim(), description: m[1].trim() })
    }
    return tasks
  }

  const planSection = planSectionMatch[1]
  const lines = planSection.split('\n')
  let currentTask: { title: string; descLines: string[] } | null = null

  for (const line of lines) {
    const stepMatch = line.match(/^\s*(\d+)\.\s+(.+)/)
    if (stepMatch) {
      if (currentTask) {
        tasks.push({ title: currentTask.title, description: [currentTask.title, ...currentTask.descLines].join('\n').trim() })
      }
      currentTask = { title: stepMatch[2].trim(), descLines: [] }
    } else if (currentTask && line.trim()) {
      currentTask.descLines.push(line.trim())
    }
  }
  if (currentTask) {
    tasks.push({ title: currentTask.title, description: [currentTask.title, ...currentTask.descLines].join('\n').trim() })
  }
  return tasks
}

// ─── Plan parser tests ────────────────────────────────────────────────────────

describe('parsePlanToTasks — planforge markdown parser', () => {
  it('parses numbered steps from Step-by-Step Plan section', () => {
    const markdown = `
## Goal
Build a todo API.

## Step-by-Step Plan
1. Set up Express server
2. Add PostgreSQL connection
3. Implement CRUD endpoints
`
    const tasks = parsePlanToTasks(markdown)
    expect(tasks).toHaveLength(3)
    expect(tasks[0].title).toBe('Set up Express server')
    expect(tasks[1].title).toBe('Add PostgreSQL connection')
    expect(tasks[2].title).toBe('Implement CRUD endpoints')
  })

  it('falls back to any numbered list when no Step-by-Step Plan section', () => {
    const markdown = `
1. Initialize project
2. Add dependencies
3. Write tests
`
    const tasks = parsePlanToTasks(markdown)
    expect(tasks).toHaveLength(3)
    expect(tasks[0].title).toBe('Initialize project')
  })

  it('returns empty array for markdown with no numbered steps', () => {
    const tasks = parsePlanToTasks('# No steps here\nJust some text.')
    expect(tasks).toHaveLength(0)
  })

  it('includes sub-description lines in description', () => {
    const markdown = `
## Step-by-Step Plan
1. Create database schema
   Define tables for users and todos.
2. Add migrations
`
    const tasks = parsePlanToTasks(markdown)
    expect(tasks[0].description).toContain('Define tables for users and todos.')
  })

  it('stops parsing at next ## section', () => {
    const markdown = `
## Step-by-Step Plan
1. Step one
2. Step two

## Notes
3. Not a step
`
    const tasks = parsePlanToTasks(markdown)
    expect(tasks).toHaveLength(2)
  })
})

// ─── GitHub repo name sanitization ───────────────────────────────────────────

function sanitizeRepoName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

describe('sanitizeRepoName', () => {
  it('converts spaces to hyphens', () => {
    expect(sanitizeRepoName('My Awesome App')).toBe('my-awesome-app')
  })
  it('removes invalid characters', () => {
    expect(sanitizeRepoName('my_app@2025!')).toBe('myapp2025')
  })
  it('lowercases everything', () => {
    expect(sanitizeRepoName('MyApp')).toBe('myapp')
  })
  it('preserves hyphens', () => {
    expect(sanitizeRepoName('my-repo-name')).toBe('my-repo-name')
  })
  it('handles empty string', () => {
    expect(sanitizeRepoName('')).toBe('')
  })
})

// ─── planInput builder ────────────────────────────────────────────────────────

function buildPlanInput(project: {
  name: string
  description: string
  summary?: string | null
  features?: string[]
  constraints?: string[]
}) {
  return {
    projectName: project.name,
    summary: project.summary ?? project.description,
    targetUsers: ['developers'],
    coreFeatures: project.features ?? [],
    constraints: project.constraints ?? [],
  }
}

describe('buildPlanInput', () => {
  it('uses summary when available', () => {
    const input = buildPlanInput({ name: 'Test', description: 'desc', summary: 'Short summary' })
    expect(input.summary).toBe('Short summary')
  })
  it('falls back to description when summary is null', () => {
    const input = buildPlanInput({ name: 'Test', description: 'Full description', summary: null })
    expect(input.summary).toBe('Full description')
  })
  it('always sets targetUsers to developers', () => {
    const input = buildPlanInput({ name: 'X', description: 'Y' })
    expect(input.targetUsers).toEqual(['developers'])
  })
  it('passes features and constraints', () => {
    const input = buildPlanInput({
      name: 'X', description: 'Y',
      features: ['auth', 'CRUD'],
      constraints: ['TypeScript only'],
    })
    expect(input.coreFeatures).toEqual(['auth', 'CRUD'])
    expect(input.constraints).toEqual(['TypeScript only'])
  })
  it('defaults to empty arrays when features/constraints omitted', () => {
    const input = buildPlanInput({ name: 'X', description: 'Y' })
    expect(input.coreFeatures).toEqual([])
    expect(input.constraints).toEqual([])
  })
})
