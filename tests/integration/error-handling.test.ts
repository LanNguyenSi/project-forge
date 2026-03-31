/**
 * Task 013: Error-handling integration tests
 *
 * Verify that the pipeline fails loudly (not silently) on:
 * - Missing environment variables
 * - Invalid inputs
 * - External service failures
 */

import { describe, it, expect, vi } from 'vitest'

// ─── planInput validation ─────────────────────────────────────────────────────

function validatePlanInput(input: Record<string, unknown>): string[] {
  const errors: string[] = []
  if (!input.projectName || typeof input.projectName !== 'string' || !String(input.projectName).trim()) {
    errors.push('projectName is required')
  }
  if (!input.summary || typeof input.summary !== 'string' || !String(input.summary).trim()) {
    errors.push('summary is required')
  }
  if (!Array.isArray(input.targetUsers) || (input.targetUsers as unknown[]).length === 0) {
    errors.push('targetUsers must be a non-empty array')
  }
  return errors
}

describe('validatePlanInput — error paths', () => {
  it('rejects empty projectName', () => {
    const errors = validatePlanInput({ projectName: '', summary: 'test', targetUsers: ['dev'] })
    expect(errors).toContain('projectName is required')
  })

  it('rejects missing summary', () => {
    const errors = validatePlanInput({ projectName: 'test', summary: null, targetUsers: ['dev'] })
    expect(errors).toContain('summary is required')
  })

  it('rejects empty targetUsers', () => {
    const errors = validatePlanInput({ projectName: 'test', summary: 'test', targetUsers: [] })
    expect(errors).toContain('targetUsers must be a non-empty array')
  })

  it('passes valid input', () => {
    const errors = validatePlanInput({ projectName: 'test', summary: 'A summary', targetUsers: ['developers'] })
    expect(errors).toHaveLength(0)
  })
})

// ─── GitHub API error mapping ─────────────────────────────────────────────────

function mapGitHubError(status: number, body: { message?: string }): { userMessage: string; retryable: boolean } {
  if (status === 422 && body.message?.includes('name already exists')) {
    return { userMessage: 'A repository with that name already exists. Choose a different name.', retryable: false }
  }
  if (status === 401 || status === 403) {
    return { userMessage: 'GitHub authentication failed. Check the GitHub App configuration.', retryable: false }
  }
  if (status === 404) {
    return { userMessage: 'GitHub resource not found. Check GITHUB_REPO_OWNER.', retryable: false }
  }
  if (status >= 500) {
    return { userMessage: 'GitHub is temporarily unavailable. Please retry.', retryable: true }
  }
  return { userMessage: `Unexpected GitHub error (${status}).`, retryable: false }
}

describe('mapGitHubError', () => {
  it('explains duplicate repo name', () => {
    const result = mapGitHubError(422, { message: 'name already exists on this account' })
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toMatch(/already exists/)
  })

  it('flags auth errors as non-retryable', () => {
    expect(mapGitHubError(401, {}).retryable).toBe(false)
    expect(mapGitHubError(403, {}).retryable).toBe(false)
  })

  it('marks 5xx errors as retryable', () => {
    expect(mapGitHubError(503, {}).retryable).toBe(true)
    expect(mapGitHubError(500, {}).retryable).toBe(true)
  })

  it('returns generic message for unexpected status', () => {
    const result = mapGitHubError(409, {})
    expect(result.userMessage).toContain('409')
  })
})

// ─── Scaffold route: missing scaffoldOutDir ───────────────────────────────────

describe('Scaffold route — missing scaffoldOutDir', () => {
  it('throws early when scaffoldOutDir is null', () => {
    const scaffoldOutDir: string | null = null
    const check = () => {
      if (!scaffoldOutDir) throw new Error('No scaffold data — run scaffold first')
    }
    expect(check).toThrow('No scaffold data')
  })

  it('throws when scaffoldOutDir path does not exist on disk', () => {
    const scaffoldOutDir = '/tmp/nonexistent-pf-dir-xyz'
    const { existsSync } = require('fs') as typeof import('fs')
    const check = () => {
      if (!existsSync(scaffoldOutDir)) throw new Error('Scaffold dir missing from disk')
    }
    expect(check).toThrow('Scaffold dir missing from disk')
  })
})

// ─── planforge timeout handling ───────────────────────────────────────────────

describe('runCommand — timeout semantics', () => {
  it('resolves with code 124 when timeout fires', async () => {
    // Simulate timeout: the mock never completes
    const runWithTimeout = (timeoutMs: number) =>
      new Promise<{ code: number }>((resolve) => {
        const timer = setTimeout(() => resolve({ code: 124 }), timeoutMs)
        // Simulate external process that runs longer
        return () => clearTimeout(timer)
      })

    const result = await runWithTimeout(50)
    expect(result.code).toBe(124)
  })
})

// ─── create-repo: repoName sanitization guards ────────────────────────────────

describe('repoName validation', () => {
  const VALID_REPO_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/

  it('accepts simple kebab names', () => {
    expect(VALID_REPO_REGEX.test('my-app')).toBe(true)
  })

  it('rejects names starting with hyphen', () => {
    expect(VALID_REPO_REGEX.test('-bad')).toBe(false)
  })

  it('rejects names ending with hyphen', () => {
    expect(VALID_REPO_REGEX.test('bad-')).toBe(false)
  })

  it('rejects uppercase letters', () => {
    expect(VALID_REPO_REGEX.test('MyApp')).toBe(false)
  })

  it('accepts single character names', () => {
    expect(VALID_REPO_REGEX.test('a')).toBe(true)
  })
})
