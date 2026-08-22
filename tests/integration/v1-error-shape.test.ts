import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Error-shape regression coverage for the v1 API surface.
 *
 * app/api/v1/generate/route.ts and app/api/v1/publish/route.ts already had
 * dedicated test files asserting `ok: false` on their error branches
 * (tests/integration/v1-generate-api.test.ts, tests/integration/v1-publish-missing-paths.test.ts,
 * tests/integration/cross-user-isolation.test.ts). This file adds the
 * missing coverage for app/api/v1/projects/route.ts (GET/DELETE/POST) and
 * app/api/v1/preview/route.ts (GET), whose error responses previously used
 * the bare `{ error, details? }` shape (POST /api/v1/projects) or had no
 * dedicated test at all (GET /api/v1/projects, DELETE /api/v1/projects,
 * GET /api/v1/preview).
 *
 * Every case below asserts `ok: false` per lib/types.ts ErrorResponse.
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      usageLog: {
        findMany: vi.fn(),
        count: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    },
    validateApiToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

import { validateApiToken, checkRateLimit } from "@/lib/db";
import { GET as projectsGET, DELETE as projectsDELETE, POST as projectsPOST } from "@/app/api/v1/projects/route";
import { GET as previewGET } from "@/app/api/v1/preview/route";

const mValidateToken = vi.mocked(validateApiToken);
const mCheckRateLimit = vi.mocked(checkRateLimit);

function tokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    token: "pf_test",
    userId: "user-1",
    name: "test",
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    user: {
      id: "user-1",
      email: "user@example.com",
      githubPat: null,
      githubOwner: null,
      githubLogin: null,
    },
    ...overrides,
  };
}

function makeReq(
  url: string,
  apiKey: string | null,
  init: { method?: string; body?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey !== null) headers["X-API-Key"] = apiKey;
  return new NextRequest(url, { method: init.method, body: init.body, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/projects error shape", () => {
  it("401 ok:false when X-API-Key header is absent", async () => {
    const res = await projectsGET(makeReq("http://test/api/v1/projects", null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing x-api-key/i);
  });

  it("401 ok:false when validateApiToken returns null", async () => {
    mValidateToken.mockResolvedValue(null as never);
    const res = await projectsGET(makeReq("http://test/api/v1/projects", "pf_invalid"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid or revoked/i);
  });
});

describe("DELETE /api/v1/projects error shape", () => {
  it("401 ok:false when X-API-Key header is absent", async () => {
    const res = await projectsDELETE(makeReq("http://test/api/v1/projects?id=abc", null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing x-api-key/i);
  });

  it("400 ok:false when id parameter is missing", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    const res = await projectsDELETE(makeReq("http://test/api/v1/projects", "pf_test"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing id parameter/i);
  });
});

describe("POST /api/v1/projects error shape", () => {
  it("401 ok:false when X-API-Key header is absent", async () => {
    const res = await projectsPOST(
      makeReq("http://test/api/v1/projects", null, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing x-api-key/i);
  });

  it("401 ok:false when validateApiToken returns null", async () => {
    mValidateToken.mockResolvedValue(null as never);
    const res = await projectsPOST(
      makeReq("http://test/api/v1/projects", "pf_invalid", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid or revoked/i);
  });

  it("429 ok:false when rate limit is exceeded", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    mCheckRateLimit.mockResolvedValue({ allowed: false, used: 10 });
    const res = await projectsPOST(
      makeReq("http://test/api/v1/projects", "pf_test", {
        method: "POST",
        body: JSON.stringify({ projectName: "p", summary: "s" }),
      }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/rate limit exceeded/i);
  });

  it("400 ok:false when required fields are missing", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });
    const res = await projectsPOST(
      makeReq("http://test/api/v1/projects", "pf_test", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing required fields/i);
  });

  it("400 ok:false when GitHub PAT is not configured", async () => {
    mValidateToken.mockResolvedValue(tokenRecord({ user: { id: "user-1", email: "u@example.com", githubPat: null } }) as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });
    const res = await projectsPOST(
      makeReq("http://test/api/v1/projects", "pf_test", {
        method: "POST",
        body: JSON.stringify({ projectName: "p", summary: "s" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/github pat not configured/i);
  });
});

describe("GET /api/v1/preview error shape", () => {
  it("401 ok:false when X-API-Key header is absent", async () => {
    const res = await previewGET(makeReq("http://test/api/v1/preview?sessionId=x", null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing x-api-key/i);
  });

  it("400 ok:false when sessionId is missing or invalid", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    const res = await previewGET(makeReq("http://test/api/v1/preview", "pf_test"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing or invalid sessionid/i);
  });

  it("404 ok:false when session does not exist", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    const res = await previewGET(
      makeReq("http://test/api/v1/preview?sessionId=00000000-0000-0000-0000-000000000000", "pf_test"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/session not found or expired/i);
  });
});
