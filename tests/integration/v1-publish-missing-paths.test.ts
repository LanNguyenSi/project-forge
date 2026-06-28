import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Tests for publish route paths NOT already covered by cross-user-isolation:
 *   - 401 missing X-API-Key
 *   - 401 invalid / revoked token
 *   - 429 rate-limit exceeded
 *   - 409 double-publish lock (.forge-published already present)
 *   - 400 missing githubPat
 *   - PAT scrub: simulated error containing a raw token must not appear in 500 body
 *
 * NOTE: FORGE_TEMP_DIR (or "/tmp/project-forge") is read at module-level by the route,
 * so we use the same value the route uses. Each test uses a unique sessionId and
 * cleans up in afterEach.
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      usageLog: { create: vi.fn() },
    },
    validateApiToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

// subprocess is mocked so tests never spawn real git processes.
vi.mock("@/lib/subprocess", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

import { validateApiToken, checkRateLimit } from "@/lib/db";
import { POST } from "@/app/api/v1/publish/route";

const mValidateToken = vi.mocked(validateApiToken);
const mCheckRateLimit = vi.mocked(checkRateLimit);

// The route reads FORGE_TEMP_DIR at module-load time, so we must use the same value.
const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      email: "u@test.com",
      passwordHash: null,
      githubId: null,
      githubLogin: null,
      githubPat: "ghp_VALID_PAT_FOR_TESTS",
      githubOwner: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  };
}

function makeReq(apiKey: string | null, body: unknown): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey !== null) {
    headers["X-API-Key"] = apiKey;
  }
  return new NextRequest("http://test/api/v1/publish", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Set up a session directory with .forge-meta.json in the route's TEMP_ROOT. */
async function setupSession(
  sessionId: string,
  metaOverrides: Record<string, unknown> = {}
): Promise<string> {
  const sessionDir = path.join(TEMP_ROOT, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const meta = {
    userId: "user-1",
    projectName: "test-project",
    createdAt: new Date().toISOString(),
    ...metaOverrides,
  };
  await fs.writeFile(path.join(sessionDir, ".forge-meta.json"), JSON.stringify(meta));
  return sessionDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/publish — missing-path coverage", () => {
  // Session IDs used by tests that need FS setup — must be unique per test.
  // These are cleaned up in afterEach.
  const createdDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up any session dirs created in this test.
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function session(id: string, overrides?: Record<string, unknown>) {
    const dir = await setupSession(id, overrides);
    createdDirs.push(dir);
    return dir;
  }

  // -------------------------------------------------------------------------
  // Auth: missing / invalid token
  // -------------------------------------------------------------------------

  it("401 when X-API-Key header is missing entirely", async () => {
    const res = await POST(makeReq(null, { sessionId: "aaaaaaaa-0000-0000-0000-000000000001" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mValidateToken).not.toHaveBeenCalled();
  });

  it("401 when validateApiToken returns null (revoked or unknown token)", async () => {
    mValidateToken.mockResolvedValue(null);
    const res = await POST(makeReq("pf_invalid", { sessionId: "aaaaaaaa-0000-0000-0000-000000000002" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(mCheckRateLimit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  it("429 when checkRateLimit returns { allowed: false }", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    mCheckRateLimit.mockResolvedValue({ allowed: false, used: 10 });

    const res = await POST(makeReq("pf_test", { sessionId: "aaaaaaaa-0000-0000-0000-000000000003" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/rate limit/i);
  });

  // -------------------------------------------------------------------------
  // Double-publish lock (409)
  // -------------------------------------------------------------------------

  it("409 when .forge-published marker file already exists", async () => {
    mValidateToken.mockResolvedValue(tokenRecord() as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });

    const sessionId = "bbbbbbbb-0000-0000-0000-000000000001";
    const sessionDir = await session(sessionId);
    // Pre-create the marker to simulate a prior publish
    await fs.writeFile(
      path.join(sessionDir, ".forge-published"),
      new Date().toISOString()
    );

    const res = await POST(makeReq("pf_test", { sessionId }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/already published/i);
  });

  // -------------------------------------------------------------------------
  // Missing GitHub PAT (400)
  // -------------------------------------------------------------------------

  it("400 when user.githubPat is null", async () => {
    const record = tokenRecord({
      user: {
        id: "user-1",
        email: "u@test.com",
        passwordHash: null,
        githubId: null,
        githubLogin: null,
        githubPat: null,
        githubOwner: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mValidateToken.mockResolvedValue(record as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });

    const sessionId = "cccccccc-0000-0000-0000-000000000001";
    await session(sessionId);

    const res = await POST(makeReq("pf_test", { sessionId }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/github pat/i);
  });

  it("400 when user.githubPat is an empty string (falsy)", async () => {
    const record = tokenRecord({
      user: {
        id: "user-1",
        email: "u@test.com",
        passwordHash: null,
        githubId: null,
        githubLogin: null,
        githubPat: "",
        githubOwner: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mValidateToken.mockResolvedValue(record as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });

    const sessionId = "dddddddd-0000-0000-0000-000000000001";
    await session(sessionId);

    const res = await POST(makeReq("pf_test", { sessionId }));
    // empty string is falsy → triggers the !user.githubPat guard → 400
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // PAT scrubbing in 500 catch block
  // -------------------------------------------------------------------------

  it("500 response body must not contain raw gho_ token shape from a simulated error", async () => {
    const secretPat = "gho_SECRETTOKEN99999";
    const record = tokenRecord({
      user: {
        id: "user-1",
        email: "u@test.com",
        passwordHash: null,
        githubId: null,
        githubLogin: null,
        githubPat: secretPat,
        githubOwner: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mValidateToken.mockResolvedValue(record as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });

    const sessionId = "eeeeeeee-0000-0000-0000-000000000001";
    await session(sessionId);

    // Make the GitHub API call fail with an error whose message contains the PAT
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(
        `gho_SECRETTOKEN99999 authentication failed: https://x-access-token:gho_SECRETTOKEN99999@github.com`
      )
    );

    try {
      const res = await POST(makeReq("pf_test", { sessionId }));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("gho_SECRETTOKEN99999");
      expect(text).not.toContain(secretPat);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("500 response body must not expose x-access-token:PAT@ push URL form", async () => {
    const record = tokenRecord();
    mValidateToken.mockResolvedValue(record as never);
    mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 });

    const sessionId = "ffffffff-0000-0000-0000-000000000001";
    await session(sessionId);

    // Simulate the typical git-push error that embeds the authed remote URL
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(
        "git push failed: https://x-access-token:ghp_VALID_PAT_FOR_TESTS@github.com/user/repo.git"
      )
    );

    try {
      const res = await POST(makeReq("pf_test", { sessionId }));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("ghp_VALID_PAT_FOR_TESTS");
      expect(text).not.toContain("x-access-token:ghp_");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
