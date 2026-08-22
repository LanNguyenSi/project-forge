import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route-level coverage for GET /api/v1/projects's limit/offset clamping
 * (app/api/v1/projects/route.ts). The spec (public/openapi.json) documents
 * limit as an integer in [1, 200] (default 50) and offset as an integer
 * >= 0 (default 0); this asserts the actual query values passed to
 * prisma.usageLog.findMany's `take`/`skip` for zero, negative,
 * over-maximum, non-numeric, and fractional query input.
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      usageLog: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    },
    validateApiToken: vi.fn(),
  };
});

import { GET as projectsGET } from "@/app/api/v1/projects/route";
import { prisma, validateApiToken } from "@/lib/db";

const mValidateToken = vi.mocked(validateApiToken);
const mFindMany = vi.mocked(prisma.usageLog.findMany);

function tokenRecord() {
  return { id: "tok-1", userId: "user-1", user: { id: "user-1" } };
}

function makeReq(url: string): NextRequest {
  return new NextRequest(url, { headers: { "X-API-Key": "pf_test" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mValidateToken.mockResolvedValue(tokenRecord() as never);
});

describe("GET /api/v1/projects limit/offset clamping", () => {
  const cases: Array<{ name: string; query: string; take: number; skip: number }> = [
    { name: "limit=0 falls back to the default 50", query: "limit=0", take: 50, skip: 0 },
    { name: "negative limit clamps up to the minimum 1", query: "limit=-3", take: 1, skip: 0 },
    { name: "over-maximum limit clamps down to 200", query: "limit=99999", take: 200, skip: 0 },
    { name: "non-numeric limit falls back to the default 50", query: "limit=abc", take: 50, skip: 0 },
    {
      name: "fractional limit/offset are clamped first, then truncated to integers",
      query: "limit=1.5&offset=2.7",
      take: 1,
      skip: 2,
    },
  ];

  for (const { name, query, take, skip } of cases) {
    it(name, async () => {
      const res = await projectsGET(makeReq(`http://test/api/v1/projects?${query}`));

      expect(res.status).toBe(200);
      expect(mFindMany).toHaveBeenCalledWith(expect.objectContaining({ take, skip }));

      const call = mFindMany.mock.calls.at(0);
      expect(call).toBeDefined();
      const passedArgs = call![0] as { take: number; skip: number };
      expect(Number.isInteger(passedArgs.take)).toBe(true);
      expect(Number.isInteger(passedArgs.skip)).toBe(true);
    });
  }
});
