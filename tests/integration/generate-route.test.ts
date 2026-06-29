import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Integration tests for app/api/generate/route.ts.
 * Auth: getServerSession from 'next-auth'.
 * Covers: 401 no session, 400 missing fields, 400 invalid projectName,
 *         500 missing PLANFORGE env, 200 happy path.
 *
 * The route's local buildFileTree reads the actual FS; we let it run on
 * the real tempDir (contains only .forge-meta.json which is skipped).
 * Task files are served from a pre-created fakeTasksDir that
 * resolvePlanforgeOutputPaths is mocked to return.
 */

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

vi.mock('@/lib/planforge-orchestrator', () => ({
  buildPlanforgeInput: vi.fn().mockResolvedValue({ planforgeInput: {} }),
}));

vi.mock('@/lib/planforge-client', () => {
  class PlanforgeClientError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'PlanforgeClientError';
    }
  }
  return {
    runPlanforgeViaHttp: vi.fn().mockResolvedValue({ scaffoldkit: { exitCode: 0, ran: true } }),
    assertScaffoldkitRan: vi.fn(),
    PlanforgeClientError,
  };
});

vi.mock('@/lib/post-scaffold-review', () => ({
  runPostScaffoldReview: vi.fn().mockResolvedValue({}),
  readPostScaffoldReview: vi.fn().mockResolvedValue(null),
  toScaffoldFitPreview: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@/lib/scaffold-attachments', () => ({
  writeAttachmentsToScaffold: vi.fn().mockResolvedValue([]),
  SCAFFOLD_ATTACHMENTS_DIR: 'docs/context',
}));

vi.mock('@/lib/planforge-output', () => ({
  readScaffoldPreview: vi.fn().mockResolvedValue({
    status: 'full',
    label: 'Full scaffold',
    summary: 'Ready for implementation.',
  }),
  resolvePlanforgeOutputPaths: vi.fn(),
}));

// @/lib/v1-shared: only validateProjectName is imported by this route; keep it real.
// No mock needed — the real implementation is a pure regex function.

import { getServerSession } from 'next-auth';
import { resolvePlanforgeOutputPaths } from '@/lib/planforge-output';
import { POST } from '@/app/api/generate/route';

const mGetSession = vi.mocked(getServerSession);
const mResolvePaths = vi.mocked(resolvePlanforgeOutputPaths);

// Fake task directory created once for the whole suite so the real
// fs.readdir / fs.readFile calls inside the route find real .md files.
let fakeTasksDir = '';

// The route reads FORGE_TEMP_DIR at module-load time; use the same default.
const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? '/tmp/project-forge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonReq(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const AUTHED_SESSION = { user: { id: 'user-1', email: 'u@test.com' } };
const VALID_BODY = { projectName: 'my-proj', summary: 'Build something great' };

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Create a real fake tasks directory with a stub .md file so the route's
  // fs.readdir + fs.readFile calls succeed on the happy path.
  fakeTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-test-tasks-'));
  await fs.writeFile(
    path.join(fakeTasksDir, '01-setup.md'),
    [
      '# Task 001: Setup project',
      '',
      '## Wave',
      '',
      'wave-1',
      '',
      '## Category',
      '',
      'foundation',
      '',
      '## Priority',
      '',
      'P0',
      '',
      '## Summary',
      '',
      'Initialize the project repository',
    ].join('\n')
  );
});

afterAll(async () => {
  if (fakeTasksDir) {
    await fs.rm(fakeTasksDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/generate', () => {
  let savedPlanforgeUrl: string | undefined;
  let savedPlanforgeToken: string | undefined;
  const createdDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    savedPlanforgeUrl = process.env.PLANFORGE_URL;
    savedPlanforgeToken = process.env.PLANFORGE_SERVICE_TOKEN;
    process.env.PLANFORGE_URL = 'http://planforge:8223';
    process.env.PLANFORGE_SERVICE_TOKEN = 'svc-token';

    // Default happy-path mock for resolvePlanforgeOutputPaths; tests that
    // need a different value override it before calling POST.
    mResolvePaths.mockResolvedValue({
      hasIndex: false,
      indexPath: null,
      tasksDir: fakeTasksDir,
      architecturePath: path.join(fakeTasksDir, 'nonexistent-arch.md'),
      scaffoldkitInputPath: '',
      planOutputPath: '',
    });
  });

  afterEach(async () => {
    if (savedPlanforgeUrl === undefined) delete process.env.PLANFORGE_URL;
    else process.env.PLANFORGE_URL = savedPlanforgeUrl;

    if (savedPlanforgeToken === undefined) delete process.env.PLANFORGE_SERVICE_TOKEN;
    else process.env.PLANFORGE_SERVICE_TOKEN = savedPlanforgeToken;

    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // AUTH: no session
  // -------------------------------------------------------------------------

  it('401 when session is null (unauthenticated)', async () => {
    mGetSession.mockResolvedValue(null);
    const res = await POST(jsonReq('http://test/api/generate', VALID_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not authenticated/i);
  });

  it('401 when session exists but user.id is missing', async () => {
    mGetSession.mockResolvedValue({ user: {} } as never);
    const res = await POST(jsonReq('http://test/api/generate', VALID_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 400: missing required fields
  // -------------------------------------------------------------------------

  it('400 when projectName is absent', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await POST(jsonReq('http://test/api/generate', { summary: 'A test' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing required fields/i);
  });

  it('400 when summary is absent', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await POST(jsonReq('http://test/api/generate', { projectName: 'my-proj' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing required fields/i);
  });

  // -------------------------------------------------------------------------
  // 400: invalid projectName
  // -------------------------------------------------------------------------

  it('400 when projectName contains spaces (invalid chars)', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const res = await POST(
      jsonReq('http://test/api/generate', {
        projectName: 'invalid name with spaces',
        summary: 'A test',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid projectname/i);
  });

  it('400 when projectName exceeds 100 chars', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    const longName = 'a'.repeat(101);
    const res = await POST(
      jsonReq('http://test/api/generate', {
        projectName: longName,
        summary: 'A test',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid projectname/i);
  });

  // -------------------------------------------------------------------------
  // 500: missing PLANFORGE_URL / PLANFORGE_SERVICE_TOKEN
  // -------------------------------------------------------------------------

  it('500 when PLANFORGE_URL is not set', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    delete process.env.PLANFORGE_URL;
    const res = await POST(jsonReq('http://test/api/generate', VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Route catch block returns generic message + details
    expect(body.error).toMatch(/failed to generate/i);
  });

  it('500 when PLANFORGE_SERVICE_TOKEN is not set', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    delete process.env.PLANFORGE_SERVICE_TOKEN;
    const res = await POST(jsonReq('http://test/api/generate', VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/failed to generate/i);
  });

  // -------------------------------------------------------------------------
  // 200: happy path
  // -------------------------------------------------------------------------

  it('200 with preview on valid authenticated request', async () => {
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);

    const res = await POST(
      jsonReq('http://test/api/generate', {
        projectName: 'my-proj',
        summary: 'Build something great',
        features: ['auth', 'dashboard'],
        constraints: ['TypeScript only'],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview).toBeDefined();
    expect(body.preview.sessionId).toBeTruthy();
    expect(body.preview.projectName).toBe('my-proj');
    // tasks parsed from the stub .md file in fakeTasksDir
    expect(Array.isArray(body.preview.tasks)).toBe(true);
    expect(body.preview.taskCount).toBeGreaterThanOrEqual(1);
    expect(body.preview.fileTree).toBeDefined();

    // Track temp dir for cleanup
    if (body.preview?.sessionId) {
      createdDirs.push(path.join(TEMP_ROOT, body.preview.sessionId as string));
    }
  });
});
