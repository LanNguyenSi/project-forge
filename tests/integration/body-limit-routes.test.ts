// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";

/**
 * Oversized-body coverage for the remaining JSON routes: dashboard
 * tokens/PAT, legacy publish, v1 publish, v1 one-shot create. Each
 * answers 413 in its own { ok: false, error } shape; invalid JSON
 * keeps answering exactly what the route answered before the cap
 * existed (pinned here too).
 */

// Comfortably over DEFAULT_MAX_BODY_BYTES (64 KiB).
const BIG_BODY = JSON.stringify({
  sessionId: "s".repeat(DEFAULT_MAX_BODY_BYTES * 2),
  projectName: "p",
  githubPat: "ghp_" + "y".repeat(DEFAULT_MAX_BODY_BYTES),
  name: "n".repeat(DEFAULT_MAX_BODY_BYTES),
});

function jsonReq(url: string, body: string, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  return new NextRequest(url, { method: "POST", headers, body });
}

function mockPrisma() {
  vi.doMock("@/lib/db", async () => {
    const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
    return {
      ...actual,
      prisma: {
        user: { findUnique: vi.fn(), update: vi.fn() },
        usageLog: { create: vi.fn() },
      },
      createApiToken: vi.fn(),
      validateApiToken: vi.fn().mockResolvedValue({ id: "tok-1", userId: "user-1", user: { githubPat: "ghp_x" } }),
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, used: 0 }),
    };
  });
}

function mockSession() {
  vi.doMock("next-auth", () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
  }));
  vi.doMock("@/lib/auth", () => ({ authOptions: {} }));
}

beforeEach(() => {
  mockPrisma();
  mockSession();
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("POST /api/dashboard/tokens body cap", () => {
  it("413 on an oversized body", async () => {
    const { POST } = await import("../../app/api/dashboard/tokens/route");
    const res = await POST(jsonReq("http://test/api/dashboard/tokens", BIG_BODY));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/too large/i);
  });
});

describe("POST /api/dashboard/pat body cap", () => {
  it("413 on an oversized body", async () => {
    const { POST } = await import("../../app/api/dashboard/pat/route");
    const res = await POST(jsonReq("http://test/api/dashboard/pat", BIG_BODY));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });
});

describe("POST /api/publish body cap", () => {
  it("413 on an oversized body", async () => {
    const { POST } = await import("../../app/api/publish/route");
    const res = await POST(jsonReq("http://test/api/publish", BIG_BODY));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("keeps answering invalid JSON with the pre-existing 500", async () => {
    const { POST } = await import("../../app/api/publish/route");
    const res = await POST(jsonReq("http://test/api/publish", "{oops"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/publish failed/i);
  });
});

describe("POST /api/v1/publish body cap", () => {
  it("413 on an oversized body", async () => {
    const { POST } = await import("../../app/api/v1/publish/route");
    const res = await POST(jsonReq("http://test/api/v1/publish", BIG_BODY, "pf_test"));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });
});

describe("POST /api/v1/projects body cap", () => {
  it("413 on an oversized body", async () => {
    const { POST } = await import("../../app/api/v1/projects/route");
    const res = await POST(jsonReq("http://test/api/v1/projects", BIG_BODY, "pf_test"));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("keeps answering invalid JSON with the pre-existing 500", async () => {
    const { POST } = await import("../../app/api/v1/projects/route");
    const res = await POST(jsonReq("http://test/api/v1/projects", "{oops", "pf_test"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/project generation failed/i);
  });
});
