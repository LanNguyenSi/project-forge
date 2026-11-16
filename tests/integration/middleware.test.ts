// @vitest-environment node
// (happy-dom's Headers drops the forbidden `host` header the redirect tests set)
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Integration tests for middleware.ts — covers all 5 logic branches:
 *   - /api/v1/* missing X-API-Key → 401
 *   - /api/v1/* key present → 200 pass-through
 *   - protected page no token → 307 redirect to /login?callbackUrl=<path and query>,
 *     on the origin the client used (Host / X-Forwarded-Host), not on req.url's
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

  // ---------------------------------------------------------------------------
  // Redirect target: callbackUrl and origin
  // ---------------------------------------------------------------------------

  async function redirectLocation(url: string, headers: Record<string, string> = {}) {
    mGetToken.mockResolvedValue(null);
    const res = await middleware(new NextRequest(url, { headers }));
    expect(res.status).toBe(307);
    return res.headers.get('location');
  }

  it('callbackUrl keeps the query of the original request', async () => {
    expect(await redirectLocation('http://test/settings?tab=x', { host: 'test' })).toBe(
      'http://test/login?callbackUrl=%2Fsettings%3Ftab%3Dx',
    );
  });

  it('callbackUrl keeps a nested path with several query parameters', async () => {
    expect(await redirectLocation('http://test/settings/tokens?a=1&b=2', { host: 'test' })).toBe(
      'http://test/login?callbackUrl=%2Fsettings%2Ftokens%3Fa%3D1%26b%3D2',
    );
  });

  it('callbackUrl is the bare path when the request has no query', async () => {
    expect(await redirectLocation('http://test/create', { host: 'test' })).toBe(
      'http://test/login?callbackUrl=%2Fcreate',
    );
  });

  it('redirects on the Host the client used, not on the host of req.url', async () => {
    // next start -H <ip> makes req.url carry another host than the client's
    expect(
      await redirectLocation('http://localhost:3150/settings?tab=x', { host: 'forge.example.test' }),
    ).toBe('http://forge.example.test/login?callbackUrl=%2Fsettings%3Ftab%3Dx');
  });

  it('keeps the port of the Host header', async () => {
    expect(
      await redirectLocation('http://localhost:3150/settings', { host: 'forge.example.test:8443' }),
    ).toBe('http://forge.example.test:8443/login?callbackUrl=%2Fsettings');
  });

  it('keeps the protocol of req.url', async () => {
    expect(
      await redirectLocation('https://localhost:3150/settings', { host: 'forge.example.test' }),
    ).toBe('https://forge.example.test/login?callbackUrl=%2Fsettings');
  });

  it('X-Forwarded-Host wins over Host', async () => {
    expect(
      await redirectLocation('http://localhost:3150/settings', {
        host: 'internal.test:3000',
        'x-forwarded-host': 'forge.example.test',
      }),
    ).toBe('http://forge.example.test/login?callbackUrl=%2Fsettings');
  });

  it('uses the first value of an X-Forwarded-Host list', async () => {
    expect(
      await redirectLocation('http://localhost:3150/settings', {
        host: 'internal.test:3000',
        'x-forwarded-host': 'forge.example.test, proxy.test',
      }),
    ).toBe('http://forge.example.test/login?callbackUrl=%2Fsettings');
  });

  it('uses Host when X-Forwarded-Host is empty', async () => {
    expect(
      await redirectLocation('http://localhost:3150/settings', {
        host: 'forge.example.test',
        'x-forwarded-host': '',
      }),
    ).toBe('http://forge.example.test/login?callbackUrl=%2Fsettings');
  });

  it('falls back to the origin of req.url when no host header is sent', async () => {
    expect(await redirectLocation('http://fallback.test:3150/settings')).toBe(
      'http://fallback.test:3150/login?callbackUrl=%2Fsettings',
    );
  });

  it.each([
    ['a path', 'evil.test/phish'],
    ['userinfo', 'user@evil.test'],
    ['a password without user name', ':secret@evil.test'],
    ['a query', 'evil.test?x=1'],
    ['a fragment', 'evil.test#x'],
    ['a space', 'evil test'],
  ])('falls back to the origin of req.url for a Host with %s', async (_name, host) => {
    const location = await redirectLocation('http://fallback.test:3150/settings', { host });
    expect(location).toBe('http://fallback.test:3150/login?callbackUrl=%2Fsettings');
  });

  it('does not run the session check for a path that only starts like a protected one', async () => {
    const res = await middleware(new NextRequest('http://test/settings-old'));
    expect(res.status).toBe(200);
    expect(mGetToken).not.toHaveBeenCalled();
  });

  it('passes an authenticated request on a nested protected path', async () => {
    mGetToken.mockResolvedValue({ sub: 'user-1' } as never);
    const res = await middleware(new NextRequest('http://test/settings/tokens?tab=x'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
