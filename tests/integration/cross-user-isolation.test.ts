import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      usageLog: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      apiToken: { findUnique: vi.fn(), update: vi.fn() },
    },
    validateApiToken: vi.fn(),
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, used: 0 }),
  };
});

import { prisma, validateApiToken } from "@/lib/db";
import { GET as listProjects, DELETE as deleteProject } from "@/app/api/v1/projects/route";
import { GET as preview } from "@/app/api/v1/preview/route";
import { POST as publish } from "@/app/api/v1/publish/route";
import { NextRequest } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";

const mValidateToken = vi.mocked(validateApiToken);
const usageLog = prisma.usageLog as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
function userARequest(url: string, init?: RequestOpts): NextRequest {
  return new NextRequest(url, {
    ...init,
    headers: { "X-API-Key": "pf_user_a_token", ...(init?.headers ?? {}) },
  });
}

function stubToken(userId: string) {
  return {
    id: `tok-${userId}`,
    token: `pf_${userId}_token`,
    userId,
    name: "test",
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    user: {
      id: userId,
      email: `${userId}@example.com`,
      passwordHash: null,
      githubId: userId,
      githubLogin: userId,
      githubPat: null,
      githubOwner: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

describe("cross-user isolation — v1 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mValidateToken.mockImplementation(async (token: string) => {
      if (token === "pf_user_a_token") return stubToken("user-a") as never;
      if (token === "pf_user_b_token") return stubToken("user-b") as never;
      return null;
    });
  });

  it("GET /api/v1/projects scopes the query to the caller's userId", async () => {
    usageLog.findMany.mockResolvedValue([]);
    usageLog.count.mockResolvedValue(0);

    await listProjects(userARequest("http://test/api/v1/projects"));

    // Invariant: the where clause passed to Prisma MUST carry the authed user id.
    const findManyArg = usageLog.findMany.mock.calls[0]?.[0];
    expect(findManyArg?.where?.userId).toBe("user-a");

    const countArg = usageLog.count.mock.calls[0]?.[0];
    expect(countArg?.where?.userId).toBe("user-a");
  });

  it("DELETE /api/v1/projects 404s when user A targets user B's row", async () => {
    // findFirst with { id, userId: 'user-a' } returns null because the row
    // is owned by user-b. The route must not fall back to updating without
    // the userId guard.
    usageLog.findFirst.mockResolvedValue(null);

    const res = await deleteProject(
      userARequest("http://test/api/v1/projects?id=row-owned-by-b", { method: "DELETE" }),
    );

    expect(res.status).toBe(404);
    expect(usageLog.update).not.toHaveBeenCalled();

    // Verify the where clause carried BOTH id and userId — this is the guard.
    const findFirstArg = usageLog.findFirst.mock.calls[0]?.[0];
    expect(findFirstArg?.where?.userId).toBe("user-a");
  });

  it("GET /api/v1/preview — user A gets 404 on user B's sessionId (not leaked as 403)", async () => {
    // The route intentionally returns 404 (not 403) on cross-user access so
    // an attacker can't probe for sessionId existence. What we MUST verify:
    // no preview data is ever returned across user boundaries.
    const tempRoot = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const sessionDir = path.join(tempRoot, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, ".forge-meta.json"),
      JSON.stringify({
        userId: "user-b",
        sessionId,
        createdAt: new Date().toISOString(),
        preview: { leakedField: "should-not-appear" },
      }),
    );

    try {
      const res = await preview(
        userARequest(`http://test/api/v1/preview?sessionId=${sessionId}`),
      );
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("leakedField");
      expect(body).not.toContain("should-not-appear");
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it("POST /api/v1/publish — user A gets 404 on user B's sessionId (not 403) and does NOT publish", async () => {
    const tempRoot = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const sessionDir = path.join(tempRoot, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, ".forge-meta.json"),
      JSON.stringify({
        userId: "user-b",
        sessionId,
        createdAt: new Date().toISOString(),
        preview: {},
      }),
    );

    try {
      const res = await publish(
        userARequest("http://test/api/v1/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }),
      );
      expect(res.status).toBe(404);
      // Hard invariant: no UsageLog row MAY be created for user A via a
      // sessionId owned by user B.
      expect(prisma.usageLog.create).not.toHaveBeenCalled?.();
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });
});
