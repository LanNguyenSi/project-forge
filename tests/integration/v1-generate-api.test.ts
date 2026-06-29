import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Integration tests for app/api/v1/generate/route.ts.
 * Covers all security/validation branches + happy path.
 *
 * Auth gate: reads X-API-Key header, then validateApiToken from @/lib/db.
 * Note: generate does NOT apply the daily rate-limit (only publish does).
 */

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    prisma: { usageLog: { create: vi.fn() } },
    validateApiToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

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

// Partial mock: readPreviewData is complex (reads FS + planforge output);
// validateProjectName is pure and must stay real so the 400 branch fires.
vi.mock('@/lib/v1-shared', async () => {
  const actual = await vi.importActual<typeof import('@/lib/v1-shared')>('@/lib/v1-shared');
  return {
    ...actual,
    readPreviewData: vi.fn().mockResolvedValue({
      projectName: 'my-proj',
      tasks: [],
      architectureOverview: '# Arch',
      fileTree: [],
      scaffold: { status: 'full', label: 'Full scaffold', summary: 'Ready.' },
      scaffoldFit: undefined,
      taskCount: 0,
      waveCount: 0,
    }),
  };
});

import { validateApiToken } from '@/lib/db';
import { POST } from '@/app/api/v1/generate/route';

const mValidateToken = vi.mocked(validateApiToken);

// The route reads FORGE_TEMP_DIR at module-load time; use the same default here.
const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? '/tmp/project-forge';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenRecord() {
  return {
    id: 'tok-1',
    token: 'pf_test',
    userId: 'user-1',
    name: 'test',
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
}

function makeReq(apiKey: string | null, body: unknown): NextRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey !== null) {
    headers['X-API-Key'] = apiKey;
  }
  return new NextRequest('http://test/api/v1/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/generate', () => {
  // Saved env so individual tests can manipulate PLANFORGE_* vars safely.
  let savedPlanforgeUrl: string | undefined;
  let savedPlanforgeToken: string | undefined;
  // Session dirs the happy-path test creates (route does NOT remove on success).
  const createdDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    savedPlanforgeUrl = process.env.PLANFORGE_URL;
    savedPlanforgeToken = process.env.PLANFORGE_SERVICE_TOKEN;
    // Set sane defaults; individual tests can unset as needed.
    process.env.PLANFORGE_URL = 'http://planforge:8223';
    process.env.PLANFORGE_SERVICE_TOKEN = 'svc-token';
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
  // AUTH: missing header
  // -------------------------------------------------------------------------

  it('401 when X-API-Key header is absent', async () => {
    const res = await POST(makeReq(null, { projectName: 'my-proj', summary: 'A test' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing x-api-key/i);
    expect(mValidateToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AUTH: invalid / revoked token
  // -------------------------------------------------------------------------

  it('401 when validateApiToken returns null (revoked or unknown token)', async () => {
    mValidateToken.mockResolvedValue(null);
    const res = await POST(makeReq('pf_invalid', { projectName: 'my-proj', summary: 'A test' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid or revoked/i);
  });

  // -------------------------------------------------------------------------
  // 400: missing required fields
  // -------------------------------------------------------------------------

  it('400 when projectName is absent', async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    const res = await POST(makeReq('pf_test', { summary: 'A test' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing required fields/i);
  });

  it('400 when summary is absent', async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    const res = await POST(makeReq('pf_test', { projectName: 'my-proj' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing required fields/i);
  });

  // -------------------------------------------------------------------------
  // 400: invalid projectName
  // -------------------------------------------------------------------------

  it('400 when projectName contains invalid characters (e.g. spaces)', async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    const res = await POST(makeReq('pf_test', { projectName: 'invalid name!', summary: 'A test' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid projectname/i);
  });

  // -------------------------------------------------------------------------
  // 500: missing PLANFORGE_URL / PLANFORGE_SERVICE_TOKEN
  // -------------------------------------------------------------------------

  it('500 when PLANFORGE_URL is not set', async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    delete process.env.PLANFORGE_URL;
    // PLANFORGE_SERVICE_TOKEN still set — but baseUrl check fires first.
    const res = await POST(makeReq('pf_test', { projectName: 'my-proj', summary: 'A test' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Route catch block returns generic "Generation failed" message
    expect(body.error).toMatch(/generation failed/i);
  });

  it('500 when PLANFORGE_SERVICE_TOKEN is not set', async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    delete process.env.PLANFORGE_SERVICE_TOKEN;
    const res = await POST(makeReq('pf_test', { projectName: 'my-proj', summary: 'A test' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/generation failed/i);
  });

  // -------------------------------------------------------------------------
  // 200: happy path (all planforge deps mocked)
  // -------------------------------------------------------------------------

  it('200 with sessionId and preview on valid authenticated request', async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);

    const res = await POST(
      makeReq('pf_test', {
        projectName: 'my-proj',
        summary: 'Build a cool project',
        features: ['auth', 'dashboard'],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeTruthy();
    expect(body.preview).toBeDefined();
    expect(body.preview.projectName).toBe('my-proj');

    // Track temp dir for cleanup (route does NOT auto-remove on success)
    if (body.sessionId) {
      createdDirs.push(path.join(TEMP_ROOT, body.sessionId as string));
    }
  });
});
