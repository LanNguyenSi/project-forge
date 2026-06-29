import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Integration tests for middleware.ts — covers all 5 logic branches:
 *   - /api/v1/* missing X-API-Key → 401
 *   - /api/v1/* key present → 200 pass-through
 *   - protected page no token → 307 redirect to /login?callbackUrl=<pathname>
 *   - protected page with token → 200 pass-through
 *   - /create path also redirects (exercises another protected-paths entry)
 */

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(),
}));

import { getToken } from 'next-auth/jwt';
import { middleware } from '@/middleware';

const mGetToken = vi.mocked(getToken);

describe('middleware', () => {
  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = 'test-secret';
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // /api/v1/* paths — validated by X-API-Key header, no session check
  // ---------------------------------------------------------------------------

  it('401 when x-api-key header is absent on /api/v1/ path', async () => {
    const req = new NextRequest('http://test/api/v1/generate', { method: 'POST' });
    const res = await middleware(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing x-api-key/i);
    // getToken must never be called for v1 paths
    expect(mGetToken).not.toHaveBeenCalled();
  });

  it('200 pass-through when x-api-key header is present on /api/v1/ path', async () => {
    const req = new NextRequest('http://test/api/v1/generate', {
      method: 'POST',
      headers: { 'x-api-key': 'pf_test_key' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    // Must not redirect
    expect(res.headers.get('location')).toBeNull();
    // No session check for v1 paths
    expect(mGetToken).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Protected page paths (/dashboard, /create, /settings)
  // ---------------------------------------------------------------------------

  it('307 redirect with /login?callbackUrl= when no token on /dashboard', async () => {
    mGetToken.mockResolvedValue(null);
    const req = new NextRequest('http://test/dashboard');
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login');
    expect(location).toContain('callbackUrl');
    // The callbackUrl should encode the protected pathname
    expect(location).toContain('dashboard');
  });

  it('200 pass-through when session token is present on /dashboard', async () => {
    mGetToken.mockResolvedValue({ sub: 'user-1' } as never);
    const req = new NextRequest('http://test/dashboard');
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('307 redirect when no token on /create path', async () => {
    mGetToken.mockResolvedValue(null);
    const req = new NextRequest('http://test/create');
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login');
    expect(location).toContain('create');
  });
});
