import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Route wiring of the quota reservation: both publishing routes take a slot
 * before the slow work (reserveUsage), turn it into the usage row of the repo
 * on success (confirmUsage) and give it back on every other exit
 * (releaseUsage). The atomic check itself is covered against a real SQLite
 * file in tests/unit/usage-reservation.test.ts.
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    validateApiToken: vi.fn(),
    reserveUsage: vi.fn(),
    confirmUsage: vi.fn(),
    releaseUsage: vi.fn(),
    prisma: { usageLog: { findMany: vi.fn(), count: vi.fn() } },
  };
});

vi.mock("@/lib/subprocess", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

vi.mock("@/lib/planforge-orchestrator", () => ({
  buildPlanforgeInput: vi.fn().mockResolvedValue({ planforgeInput: {} }),
}));
vi.mock("@/lib/planforge-client", () => ({
  runPlanforgeViaHttp: vi.fn().mockResolvedValue({}),
  assertScaffoldkitRan: vi.fn(),
  PlanforgeClientError: class extends Error {},
}));
vi.mock("@/lib/post-scaffold-review", () => ({
  runPostScaffoldReview: vi.fn().mockResolvedValue({}),
}));

import { validateApiToken, reserveUsage, confirmUsage, releaseUsage, GITHUB_REPO_CREATE_TIMEOUT_MS, GENERATION_TIMEOUT_MS, GIT_COMMAND_TIMEOUT_MS, GIT_PUSH_TIMEOUT_MS, GIT_COMMANDS_AT_DEFAULT_TIMEOUT } from "@/lib/db";
import { runCommand } from "@/lib/subprocess";
import { runPlanforgeViaHttp } from "@/lib/planforge-client";
import { POST as publishPOST } from "@/app/api/v1/publish/route";
import { POST as projectsPOST, GET as projectsGET } from "@/app/api/v1/projects/route";
import { encryptGithubPat } from "@/lib/github-pat";

const mValidate = vi.mocked(validateApiToken);
const mReserve = vi.mocked(reserveUsage);
const mConfirm = vi.mocked(confirmUsage);
const mRelease = vi.mocked(releaseUsage);

// The routes read FORGE_TEMP_DIR at module-load time.
const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const SESSION_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const REPO_URL = "https://github.com/octo/demo";

function token(githubPat: string | null = "ghp_VALID_PAT_FOR_TESTS") {
  return {
    id: "tok-1",
    userId: "user-1",
    revokedAt: null,
    user: { id: "user-1", email: "u@test.com", githubPat, githubOwner: "octo", githubLogin: "octo" },
  };
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "pf_test" },
    body: JSON.stringify(body),
  });
}

function stubGithub(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const githubOk = { html_url: REPO_URL, clone_url: `${REPO_URL}.git` };

beforeEach(() => {
  vi.clearAllMocks();
  mConfirm.mockResolvedValue(undefined);
  mRelease.mockResolvedValue(undefined);
  mReserve.mockResolvedValue({ allowed: true, reservationId: "res-1" });
  mValidate.mockResolvedValue(token() as never);
  vi.mocked(runPlanforgeViaHttp).mockResolvedValue({} as never);
  vi.stubEnv("PLANFORGE_URL", "http://planforge:8223");
  vi.stubEnv("PLANFORGE_SERVICE_TOKEN", "svc");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(path.join(TEMP_ROOT, SESSION_ID), { recursive: true, force: true });
});

async function session(meta: Record<string, unknown> = {}) {
  const dir = path.join(TEMP_ROOT, SESSION_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ".forge-meta.json"),
    JSON.stringify({ userId: "user-1", projectName: "demo", createdAt: new Date().toISOString(), ...meta }),
  );
}

describe("POST /api/v1/publish: quota reservation", () => {
  it("429 reserves nothing and releases nothing", async () => {
    mReserve.mockResolvedValue({ allowed: false, used: 10 });
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(429);
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("reserves for the authed user and token before any work", async () => {
    mValidate.mockResolvedValue(token() as never);
    // no session dir: stops early with 404, the reservation call is what counts
    await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(mReserve).toHaveBeenCalledWith("user-1", "tok-1");
  });

  it("success confirms the reservation with the repo url and does not release it", async () => {
    await session();
    stubGithub(201, githubOk);
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(200);
    expect(mConfirm).toHaveBeenCalledTimes(1);
    expect(mConfirm).toHaveBeenCalledWith("res-1", REPO_URL);
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("releases the reservation when the GitHub push fails (500)", async () => {
    await session();
    stubGithub(500, { message: "boom" });
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(500);
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation when confirming the usage row throws", async () => {
    await session();
    stubGithub(201, githubOk);
    mConfirm.mockRejectedValue(new Error("db down"));
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(500);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation on an early 400 (invalid sessionId)", async () => {
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation on 404 (session not found)", async () => {
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(404);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation on 400 (no GitHub PAT)", async () => {
    await session();
    mValidate.mockResolvedValue(token(null) as never);
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(400);
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });
});

describe("POST /api/v1/projects: quota reservation", () => {
  const body = { projectName: "demo", summary: "A demo project" };

  it("429 reserves nothing and releases nothing; the response shape is unchanged", async () => {
    mReserve.mockResolvedValue({ allowed: false, used: 10 });
    const res = await projectsPOST(post("http://test/api/v1/projects", body));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      ok: false,
      error: "Rate limit exceeded",
      details: "Maximum 10 projects per rolling 24 hours. Used: 10/10",
    });
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("success confirms the reservation with the repo url and does not release it", async () => {
    stubGithub(201, githubOk);
    const res = await projectsPOST(post("http://test/api/v1/projects", body));
    expect(res.status).toBe(200);
    expect(mReserve).toHaveBeenCalledWith("user-1", "tok-1");
    expect(mConfirm).toHaveBeenCalledTimes(1);
    expect(mConfirm).toHaveBeenCalledWith("res-1", REPO_URL);
    expect(mRelease).not.toHaveBeenCalled();
  });

  it("releases the reservation when generation fails (500)", async () => {
    vi.mocked(runPlanforgeViaHttp).mockRejectedValue(new Error("planforge down"));
    const res = await projectsPOST(post("http://test/api/v1/projects", body));
    expect(res.status).toBe(500);
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation when the GitHub push fails (500)", async () => {
    stubGithub(500, { message: "boom" });
    const res = await projectsPOST(post("http://test/api/v1/projects", body));
    expect(res.status).toBe(500);
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation on 400 (missing fields)", async () => {
    const res = await projectsPOST(post("http://test/api/v1/projects", { projectName: "demo" }));
    expect(res.status).toBe(400);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("releases the reservation on 400 (no GitHub PAT)", async () => {
    mValidate.mockResolvedValue(token(null) as never);
    const res = await projectsPOST(post("http://test/api/v1/projects", body));
    expect(res.status).toBe(400);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });
});

describe("timeout bounds on the GitHub repo-create fetch", () => {
  // The signal is what keeps a stalled api.github.com call from holding the
  // quota reservation past its TTL (worst-case sum: lib/db.ts).
  const createBody = { projectName: "demo", summary: "A demo project" };

  function timeoutRejection(): Error {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
  }

  function stubFetchCapturingSignal() {
    const captured: { signal?: AbortSignal | null } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        captured.signal = init?.signal;
        return new Response(JSON.stringify(githubOk), { status: 201 });
      }),
    );
    return captured;
  }

  function stubFetchTimingOut() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutRejection();
      }),
    );
  }

  it("POST /api/v1/projects: repo-create fetch gets AbortSignal.timeout(GITHUB_REPO_CREATE_TIMEOUT_MS)", async () => {
    const captured = stubFetchCapturingSignal();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const res = await projectsPOST(post("http://test/api/v1/projects", createBody));
      expect(res.status).toBe(200);
      expect(timeoutSpy).toHaveBeenCalledWith(GITHUB_REPO_CREATE_TIMEOUT_MS);
      expect(captured.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("POST /api/v1/publish: repo-create fetch gets AbortSignal.timeout(GITHUB_REPO_CREATE_TIMEOUT_MS)", async () => {
    await session();
    const captured = stubFetchCapturingSignal();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
      expect(res.status).toBe(200);
      expect(timeoutSpy).toHaveBeenCalledWith(GITHUB_REPO_CREATE_TIMEOUT_MS);
      expect(captured.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("POST /api/v1/projects: a repo-create timeout answers the route's 500 and releases the reservation", async () => {
    stubFetchTimingOut();
    const res = await projectsPOST(post("http://test/api/v1/projects", createBody));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Project generation failed");
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });

  it("POST /api/v1/publish: a repo-create timeout answers the route's 500 and releases the reservation", async () => {
    await session();
    stubFetchTimingOut();
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Publish failed");
    expect(mConfirm).not.toHaveBeenCalled();
    expect(mRelease).toHaveBeenCalledTimes(1);
    expect(mRelease).toHaveBeenCalledWith("res-1");
  });
});

/**
 * The routes must USE the named bounds, not just have them exported: the
 * worst-case sum of lib/db.ts is only true while every git call of a route
 * runs at one of the two named timeouts and the planforge call at
 * GENERATION_TIMEOUT_MS. `runCommand` is mocked here, so its recorded
 * options are the timeouts the route actually passed.
 */
function gitTimeouts(): { defaults: number[]; pushes: number[] } {
  const defaults: number[] = [];
  const pushes: number[] = [];
  for (const call of vi.mocked(runCommand).mock.calls) {
    const [cmd, args, options] = call as unknown as [string, string[], { timeoutMs?: number }];
    expect(cmd).toBe("git");
    (args[0] === "push" ? pushes : defaults).push(options.timeoutMs as number);
  }
  return { defaults, pushes };
}

function expectNamedGitTimeouts() {
  const { defaults, pushes } = gitTimeouts();
  // One push per route, everything else at the default bound, and the count
  // is the constant the worst-case sum multiplies by GIT_COMMAND_TIMEOUT_MS,
  // so a new git step in a route fails here instead of drifting from the sum.
  expect(pushes).toEqual([GIT_PUSH_TIMEOUT_MS]);
  expect(defaults).toEqual(new Array(GIT_COMMANDS_AT_DEFAULT_TIMEOUT).fill(GIT_COMMAND_TIMEOUT_MS));
}

describe("timeout bounds on the git calls and the planforge call", () => {
  const createBody = { projectName: "demo", summary: "A demo project" };

  it("POST /api/v1/projects: every git call runs at a named bound (push at GIT_PUSH_TIMEOUT_MS, GIT_COMMANDS_AT_DEFAULT_TIMEOUT at the default one)", async () => {
    stubGithub(201, githubOk);
    const res = await projectsPOST(post("http://test/api/v1/projects", createBody));
    expect(res.status).toBe(200);
    expectNamedGitTimeouts();
  });

  it("POST /api/v1/publish: every git call runs at a named bound (push at GIT_PUSH_TIMEOUT_MS, GIT_COMMANDS_AT_DEFAULT_TIMEOUT at the default one)", async () => {
    await session();
    stubGithub(201, githubOk);
    const res = await publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }));
    expect(res.status).toBe(200);
    expectNamedGitTimeouts();
  });

  it("POST /api/v1/projects: the planforge call gets timeoutMs: GENERATION_TIMEOUT_MS", async () => {
    stubGithub(201, githubOk);
    const res = await projectsPOST(post("http://test/api/v1/projects", createBody));
    expect(res.status).toBe(200);
    expect(runPlanforgeViaHttp).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(runPlanforgeViaHttp).mock.calls[0] as unknown as [
      { timeoutMs?: number },
    ];
    expect(options.timeoutMs).toBe(GENERATION_TIMEOUT_MS);
  });
});

describe("GET /api/v1/projects: pending reservations", () => {
  it("lists only rows that have a repoUrl, in the page and in the total", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.usageLog.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.usageLog.count).mockResolvedValue(0 as never);
    const res = await projectsGET(
      new NextRequest("http://test/api/v1/projects", { headers: { "X-API-Key": "pf_test" } }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.usageLog.findMany).mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "user-1",
      repoUrl: { not: null },
    });
    expect(vi.mocked(prisma.usageLog.count).mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "user-1",
      repoUrl: { not: null },
    });
  });
});

describe("publishing with an encrypted githubPat", () => {
  const PLAIN = "ghp_ENCRYPTED_AT_REST_TOKEN";

  function githubCalls() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(githubOk), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function pushArgs(): string {
    return vi
      .mocked(runCommand)
      .mock.calls.map((call) => (call[1] as string[]).join(" "))
      .join("\n");
  }

  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_SECRET", "publish-encrypted-pat-secret");
  });

  for (const [name, call] of [
    ["POST /api/v1/publish", () => publishPOST(post("http://test/api/v1/publish", { sessionId: SESSION_ID }))],
    ["POST /api/v1/projects", () => projectsPOST(post("http://test/api/v1/projects", { projectName: "demo", summary: "s" }))],
  ] as const) {
    it(`${name} calls GitHub with the decrypted token`, async () => {
      await session();
      mValidate.mockResolvedValue(token(encryptGithubPat(PLAIN)) as never);
      const fetchMock = githubCalls();

      const res = await call();

      expect(res.status).toBe(200);
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${PLAIN}`);
      expect(pushArgs()).toContain(`${PLAIN}@`);
      expect(pushArgs()).not.toContain("v1:");
    });

    it(`${name} answers "not configured" for a token that no longer decrypts`, async () => {
      await session();
      mValidate.mockResolvedValue(
        token(encryptGithubPat(PLAIN, { NEXTAUTH_SECRET: "the-previous-secret" })) as never,
      );
      const fetchMock = githubCalls();

      const res = await call();

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/GitHub PAT not configured/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
