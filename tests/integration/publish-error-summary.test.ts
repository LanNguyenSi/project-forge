import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Route-level contract for the publish 500 bodies (both
 * `POST /api/publish` and `POST /api/v1/publish`):
 *   - git stderr, temp-dir paths and remote URLs never reach the client;
 *     the body carries a fixed reason sentence or the generic sentence with
 *     a reference id;
 *   - the full secret-scrubbed stderr is logged server-side; only the
 *     generic answer carries a reference id, and it is the same id the
 *     response carries (known cases are logged without one);
 *   - every status code is pinned so the change cannot shift them.
 *
 * Both routes read FORGE_TEMP_DIR at module load; set FORGE_TEMP_DIR to
 * override the default /tmp/project-forge.
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      user: { findUnique: vi.fn() },
      usageLog: { create: vi.fn() },
    },
    validateApiToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

// subprocess is mocked so tests never spawn real git processes.
vi.mock("@/lib/subprocess", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

import { prisma, validateApiToken, checkRateLimit } from "@/lib/db";
import { getServerSession } from "next-auth";
import { POST as legacyPublish } from "@/app/api/publish/route";
import { POST as v1Publish } from "@/app/api/v1/publish/route";

const mSession = vi.mocked(getServerSession);
const mFindUnique = vi.mocked(prisma.user.findUnique);
const mValidateToken = vi.mocked(validateApiToken);
const mCheckRateLimit = vi.mocked(checkRateLimit);

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";

const GENERIC = /^An internal error occurred\. Reference: [0-9a-f]{8}$/;

// A throw that matches no known case: the client must see the generic
// sentence only, the log must keep the detail.
const UNKNOWN_THROWABLE =
  "fatal: bogus internal state while exporting /tmp/project-forge/abc123/repo " +
  "to https://github.com/owner/repo.git with token gho_RouteSecret123";

// git's real push rejection for a missing `workflow` OAuth scope.
const WORKFLOW_STDERR = [
  "git exited with code 1",
  "Stdout: ",
  "Stderr: To https://github.com/owner/repo.git",
  " ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
  "error: failed to push some refs to 'https://github.com/owner/repo.git'",
].join("\n");

function req(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function v1Req(body: unknown, apiKey = "pf_test"): NextRequest {
  return req("http://test/api/v1/publish", body, { "X-API-Key": apiKey });
}

function legacyReq(body: unknown): NextRequest {
  return req("http://test/api/publish", body);
}

function tokenRecord(githubPat: string | null) {
  return {
    id: "tok-1",
    token: "pf_test",
    userId: "user-1",
    user: { id: "user-1", email: "u@test.com", githubPat },
  };
}

const createdDirs: string[] = [];

/** Session dir with a fresh, owned, unexpired .forge-meta.json. */
async function setupSession(sessionId: string, meta: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(TEMP_ROOT, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ".forge-meta.json"),
    JSON.stringify({
      userId: "user-1",
      projectName: "demo",
      createdAt: new Date().toISOString(),
      ...meta,
    }),
  );
  createdDirs.push(dir);
  return dir;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mSession.mockResolvedValue({ user: { id: "user-1" } } as never);
  mFindUnique.mockResolvedValue({ id: "user-1", githubPat: "ghp_userPatForTests" } as never);
  mValidateToken.mockResolvedValue(tokenRecord("ghp_userPatForTests") as never);
  mCheckRateLimit.mockResolvedValue({ allowed: true, used: 0 } as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of createdDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function loggedBlob(): { prefix: string; blob: string } {
  expect(logSpy).toHaveBeenCalledTimes(1);
  const [prefix, blob] = logSpy.mock.calls[0] as [unknown, unknown];
  return { prefix: String(prefix), blob: String(blob) };
}

/** Assert the body leaked nothing of the raw stderr. */
function expectNoInternals(text: string): void {
  expect(text).not.toContain("/tmp/project-forge/abc123/repo");
  expect(text).not.toContain("github.com/owner/repo.git");
  expect(text).not.toContain("gho_RouteSecret123");
  expect(text).not.toContain("bogus internal state");
}

describe("POST /api/publish (legacy): status codes pinned", () => {
  it("400 when sessionId or projectName is missing", async () => {
    expect((await legacyPublish(legacyReq({}))).status).toBe(400);
  });

  it("400 for a non-UUID sessionId", async () => {
    const res = await legacyPublish(legacyReq({ sessionId: "../../etc", projectName: "demo" }));
    expect(res.status).toBe(400);
  });

  it("401 without a session", async () => {
    mSession.mockResolvedValue(null as never);
    const res = await legacyPublish(legacyReq({ sessionId: "a1111111-0000-4000-8000-000000000001", projectName: "demo" }));
    expect(res.status).toBe(401);
  });

  it("400 when the user has no GitHub PAT", async () => {
    mFindUnique.mockResolvedValue({ id: "user-1", githubPat: null } as never);
    const res = await legacyPublish(legacyReq({ sessionId: "a1111111-0000-4000-8000-000000000002", projectName: "demo" }));
    expect(res.status).toBe(400);
  });

  it("404 when the session dir does not exist", async () => {
    const res = await legacyPublish(legacyReq({ sessionId: "a1111111-0000-4000-8000-000000000003", projectName: "demo" }));
    expect(res.status).toBe(404);
  });

  it("404 when the session belongs to another user (IDOR guard)", async () => {
    await setupSession("a1111111-0000-4000-8000-000000000004", { userId: "user-2" });
    const res = await legacyPublish(legacyReq({ sessionId: "a1111111-0000-4000-8000-000000000004", projectName: "demo" }));
    expect(res.status).toBe(404);
  });

  it("404 when the session is expired", async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await setupSession("a1111111-0000-4000-8000-000000000005", { createdAt });
    const res = await legacyPublish(legacyReq({ sessionId: "a1111111-0000-4000-8000-000000000005", projectName: "demo" }));
    expect(res.status).toBe(404);
  });

  it("500 with the generic sentence: no stderr, path, URL or token in the body", async () => {
    const sessionId = "a1111111-0000-4000-8000-000000000006";
    await setupSession(sessionId);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(UNKNOWN_THROWABLE));
    try {
      const res = await legacyPublish(legacyReq({ sessionId, projectName: "demo" }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Publish failed");
      expect(body.details).toMatch(GENERIC);
      expectNoInternals(JSON.stringify(body));

      // The reference id in the body is the one that was logged, and the log
      // kept the full detail with the token scrubbed.
      const ref = body.details.match(/Reference: ([0-9a-f]{8})$/)[1];
      const { prefix, blob } = loggedBlob();
      expect(prefix).toBe(`[${ref}] Publish failed:`);
      expect(blob).toContain("/tmp/project-forge/abc123/repo");
      expect(blob).toContain("https://github.com/owner/repo.git");
      expect(blob).not.toContain("gho_RouteSecret123");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("500 with the fixed workflow-scope sentence for a scope rejection", async () => {
    const sessionId = "a1111111-0000-4000-8000-000000000007";
    await setupSession(sessionId);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(WORKFLOW_STDERR));
    try {
      const res = await legacyPublish(legacyReq({ sessionId, projectName: "demo" }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Publish failed");
      expect(body.details).toMatch(/lacks the workflow scope/i);
      expect(body.details).not.toContain("github.com");
      // Known case: logged without a reference id (only the generic answer
      // carries one, and a logged id the client never sees would be noise).
      expect(loggedBlob().prefix).toBe("Publish failed:");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("POST /api/v1/publish: status codes pinned", () => {
  it("401 when the X-API-Key header is missing", async () => {
    const res = await v1Publish(req("http://test/api/v1/publish", { sessionId: "b2222222-0000-4000-8000-000000000001" }));
    expect(res.status).toBe(401);
  });

  it("401 when the token does not validate", async () => {
    mValidateToken.mockResolvedValue(null as never);
    const res = await v1Publish(v1Req({ sessionId: "b2222222-0000-4000-8000-000000000002" }));
    expect(res.status).toBe(401);
  });

  it("429 when the rate limit is exhausted", async () => {
    mCheckRateLimit.mockResolvedValue({ allowed: false, used: 10 } as never);
    const res = await v1Publish(v1Req({ sessionId: "b2222222-0000-4000-8000-000000000003" }));
    expect(res.status).toBe(429);
  });

  it("404 when the session dir does not exist", async () => {
    const res = await v1Publish(v1Req({ sessionId: "b2222222-0000-4000-8000-000000000004" }));
    expect(res.status).toBe(404);
  });

  it("404 when the session belongs to another user", async () => {
    await setupSession("b2222222-0000-4000-8000-000000000005", { userId: "user-2" });
    const res = await v1Publish(v1Req({ sessionId: "b2222222-0000-4000-8000-000000000005" }));
    expect(res.status).toBe(404);
  });

  it("404 when the session is expired", async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await setupSession("b2222222-0000-4000-8000-000000000006", { createdAt });
    const res = await v1Publish(v1Req({ sessionId: "b2222222-0000-4000-8000-000000000006" }));
    expect(res.status).toBe(404);
  });

  it("409 when the session is already published", async () => {
    const sessionId = "b2222222-0000-4000-8000-000000000007";
    const dir = await setupSession(sessionId);
    await fs.writeFile(path.join(dir, ".forge-published"), new Date().toISOString());
    const res = await v1Publish(v1Req({ sessionId }));
    expect(res.status).toBe(409);
  });

  it("400 when the user has no GitHub PAT", async () => {
    mValidateToken.mockResolvedValue(tokenRecord(null) as never);
    const sessionId = "b2222222-0000-4000-8000-000000000008";
    await setupSession(sessionId);
    const res = await v1Publish(v1Req({ sessionId }));
    expect(res.status).toBe(400);
  });

  it("500 with the generic sentence: error prefix kept, no internals, ref matches the log", async () => {
    const sessionId = "b2222222-0000-4000-8000-000000000009";
    await setupSession(sessionId);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(UNKNOWN_THROWABLE));
    try {
      const res = await v1Publish(v1Req({ sessionId }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe(`Publish failed: ${body.details}`);
      expect(body.details).toMatch(GENERIC);
      expectNoInternals(JSON.stringify(body));

      const ref = body.details.match(/Reference: ([0-9a-f]{8})$/)[1];
      const { prefix, blob } = loggedBlob();
      expect(prefix).toBe(`[${ref}] Publish failed:`);
      expect(blob).toContain("/tmp/project-forge/abc123/repo");
      expect(blob).not.toContain("gho_RouteSecret123");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("500 with the fixed workflow-scope sentence for a scope rejection", async () => {
    const sessionId = "b2222222-0000-4000-8000-00000000000a";
    await setupSession(sessionId);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(WORKFLOW_STDERR));
    try {
      const res = await v1Publish(v1Req({ sessionId }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/^Publish failed: .*workflow scope/i);
      expect(body.details).toMatch(/lacks the workflow scope/i);
      expect(body.details).not.toContain("github.com");
      // Known case: logged without a reference id.
      expect(loggedBlob().prefix).toBe("Publish failed:");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("500 with the credentials sentence and a scrubbed log for an auth failure", async () => {
    const sessionId = "b2222222-0000-4000-8000-00000000000b";
    await setupSession(sessionId);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fatal: Authentication failed for https://x-access-token:ghp_RouteSecret456@github.com/owner/repo.git"));
    try {
      const res = await v1Publish(v1Req({ sessionId }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.details).toMatch(/rejected the credentials/i);
      expect(body.details).not.toContain("ghp_RouteSecret456");
      const { blob } = loggedBlob();
      expect(blob).toContain("https://***@");
      expect(blob).not.toContain("ghp_RouteSecret456");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
