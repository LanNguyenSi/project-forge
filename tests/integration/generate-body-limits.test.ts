// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Body-cap + attachment-limit coverage for POST /api/generate and
 * POST /api/v1/generate: oversized payloads must answer 413 BEFORE the
 * route mkdirs a temp dir or writes any attachment to disk. fs/promises
 * is wrapped (not replaced) so mkdir is observable while every real
 * call still hits the real FS.
 */

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
  };
});

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: { usageLog: { create: vi.fn() } },
    validateApiToken: vi.fn(),
    checkRateLimit: vi.fn(),
  };
});

vi.mock("@/lib/planforge-orchestrator", () => ({
  buildPlanforgeInput: vi.fn().mockResolvedValue({ planforgeInput: {} }),
}));

vi.mock("@/lib/planforge-client", () => {
  class PlanforgeClientError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "PlanforgeClientError";
    }
  }
  return {
    runPlanforgeViaHttp: vi.fn().mockResolvedValue({ scaffoldkit: { exitCode: 0, ran: true } }),
    assertScaffoldkitRan: vi.fn(),
    PlanforgeClientError,
  };
});

vi.mock("@/lib/post-scaffold-review", () => ({
  runPostScaffoldReview: vi.fn().mockResolvedValue({}),
  readPostScaffoldReview: vi.fn().mockResolvedValue(null),
  toScaffoldFitPreview: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@/lib/scaffold-attachments", () => ({
  writeAttachmentsToScaffold: vi.fn().mockResolvedValue([]),
  SCAFFOLD_ATTACHMENTS_DIR: "docs/context",
}));

vi.mock("@/lib/planforge-output", () => ({
  readScaffoldPreview: vi.fn().mockResolvedValue({ status: "full", label: "Full scaffold", summary: "Ready." }),
  resolvePlanforgeOutputPaths: vi.fn().mockResolvedValue({
    hasIndex: false,
    indexPath: null,
    tasksDir: "",
    architecturePath: "",
    scaffoldkitInputPath: "",
    planOutputPath: "",
  }),
}));

import { mkdir as mkdirImported } from "fs/promises";
import { getServerSession } from "next-auth";
import { validateApiToken } from "@/lib/db";
import { buildPlanforgeInput } from "@/lib/planforge-orchestrator";
import { writeAttachmentsToScaffold } from "@/lib/scaffold-attachments";
import { POST as generate } from "@/app/api/generate/route";
import { POST as v1Generate } from "@/app/api/v1/generate/route";
import { GENERATE_MAX_BODY_BYTES, MAX_ATTACHMENT_CHARS } from "@/lib/limits";

const mGetSession = vi.mocked(getServerSession);
const mValidateToken = vi.mocked(validateApiToken);
const mBuildPlanforgeInput = vi.mocked(buildPlanforgeInput);
const mWriteAttachments = vi.mocked(writeAttachmentsToScaffold);
const mMkdir = vi.mocked(mkdirImported);

const AUTHED_SESSION = { user: { id: "user-1", email: "u@test.com" } };
const TOKEN_RECORD = { id: "tok-1", userId: "user-1", user: { githubPat: "ghp_x" } };

function attachment(chars: number, name = "doc.md", fill = "x") {
  return { name, mimeType: "text/markdown", tier: "text" as const, inlineText: fill.repeat(chars) };
}

function jsonReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/generate body & attachment caps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mGetSession.mockResolvedValue(AUTHED_SESSION as never);
    process.env.PLANFORGE_URL = "http://planforge:8223";
    process.env.PLANFORGE_SERVICE_TOKEN = "svc-token";
  });

  it("413 on a body over GENERATE_MAX_BODY_BYTES, before mkdir or any pipeline call", async () => {
    const res = await generate(
      jsonReq("http://test/api/generate", {
        projectName: "my-proj",
        summary: "x".repeat(GENERATE_MAX_BODY_BYTES + 1000),
      })
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/body too large/i);
    expect(mMkdir).not.toHaveBeenCalled();
    expect(mBuildPlanforgeInput).not.toHaveBeenCalled();
    expect(mWriteAttachments).not.toHaveBeenCalled();
  });

  it("413 on one attachment over the per-file cap (before any write)", async () => {
    const res = await generate(
      jsonReq("http://test/api/generate", {
        projectName: "my-proj",
        summary: "A test",
        attachments: [attachment(MAX_ATTACHMENT_CHARS + 1, "huge.md")],
      })
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details).toMatch(/per file/i);
    expect(body.details).toMatch(/50,001/);
    expect(mMkdir).not.toHaveBeenCalled();
    expect(mWriteAttachments).not.toHaveBeenCalled();
  });

  it("413 when attachments together exceed the total cap (each file individually in budget)", async () => {
    const res = await generate(
      jsonReq("http://test/api/generate", {
        projectName: "my-proj",
        summary: "A test",
        attachments: [attachment(30_000, "a.md"), attachment(30_000, "b.md")],
      })
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details).toMatch(/total/i);
    expect(mMkdir).not.toHaveBeenCalled();
    expect(mWriteAttachments).not.toHaveBeenCalled();
  });

  it("413 on more attachments than the count cap (per-file and total in budget)", async () => {
    const res = await generate(
      jsonReq("http://test/api/generate", {
        projectName: "my-proj",
        summary: "A test",
        attachments: [attachment(20_000, "a.md"), attachment(20_000, "b.md")],
      })
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details).toMatch(/too many attachments/i);
    expect(mMkdir).not.toHaveBeenCalled();
    expect(mWriteAttachments).not.toHaveBeenCalled();
  });

  it("accepts a single attachment at exactly the per-file/total cap (boundary): proceeds past the gate", async () => {
    // PLANFORGE_URL unset makes the pipeline fail with its existing 500
    // after the attachment gate; what is pinned here is that the answer
    // is NOT 413 and the route got as far as creating the session dir.
    delete process.env.PLANFORGE_URL;
    const res = await generate(
      jsonReq("http://test/api/generate", {
        projectName: "my-proj",
        summary: "A test",
        attachments: [attachment(MAX_ATTACHMENT_CHARS)],
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed to generate/i);
    expect(mWriteAttachments).not.toHaveBeenCalled();
    expect(mMkdir).toHaveBeenCalledOnce();
  });

  it("accepts a legitimate maximal body far above 64 KiB on the wire", async () => {
    // A single attachment at exactly the per-file/total cap (50k chars)
    // plus a large summary, all U+0001 (the worst-case JSON escape, 6
    // bytes per char): ~420 KB on the wire, 6.4x over the 64 KiB
    // default cap yet inside GENERATE_MAX_BODY_BYTES, so no check on
    // the route's way may answer 413. PLANFORGE_URL unset makes the
    // pipeline fail with its existing 500 after every size gate, which
    // is what pins "accepted": the answer is the pipeline 500, and the
    // session dir got created.
    delete process.env.PLANFORGE_URL;
    delete process.env.PLANFORGE_SERVICE_TOKEN;
    const body = {
      projectName: "my-proj",
      summary: "\u0001".repeat(20_000),
      attachments: [attachment(MAX_ATTACHMENT_CHARS, "doc.md", "\u0001")],
    };
    const wireBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(wireBytes).toBeGreaterThan(64 * 1024);
    expect(wireBytes).toBeLessThanOrEqual(GENERATE_MAX_BODY_BYTES);
    const res = await generate(jsonReq("http://test/api/generate", body));
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toMatch(/failed to generate/i);
    expect(mMkdir).toHaveBeenCalledOnce();
  });
});

describe("POST /api/v1/generate body & attachment caps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mValidateToken.mockResolvedValue(TOKEN_RECORD as never);
  });

  function v1Req(body: unknown): NextRequest {
    return new NextRequest("http://test/api/v1/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "pf_test" },
      body: JSON.stringify(body),
    });
  }

  it("413 on a body over GENERATE_MAX_BODY_BYTES, before mkdir", async () => {
    const res = await v1Generate(
      v1Req({ projectName: "my-proj", summary: "x".repeat(GENERATE_MAX_BODY_BYTES + 1000) })
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/body too large/i);
    expect(mMkdir).not.toHaveBeenCalled();
    expect(mBuildPlanforgeInput).not.toHaveBeenCalled();
  });

  it("413 on an attachment over the per-file cap, before mkdir", async () => {
    const res = await v1Generate(
      v1Req({
        projectName: "my-proj",
        summary: "A test",
        attachments: [attachment(MAX_ATTACHMENT_CHARS + 1)],
      })
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details).toMatch(/per file/i);
    expect(mMkdir).not.toHaveBeenCalled();
  });

  it("accepts a legitimate maximal body far above 64 KiB on the wire", async () => {
    // Same worst-case-escaped payload as the web route's acceptance
    // test: an attachment at exactly the per-file/total cap plus a
    // large summary, ~420 KB on the wire. The v1 route still runs the
    // attachment gate and reads under GENERATE_MAX_BODY_BYTES, so the
    // answer is the pipeline's own failure, never 413.
    delete process.env.PLANFORGE_URL;
    delete process.env.PLANFORGE_SERVICE_TOKEN;
    const body = {
      projectName: "my-proj",
      summary: "\u0001".repeat(20_000),
      attachments: [attachment(MAX_ATTACHMENT_CHARS, "doc.md", "\u0001")],
    };
    const wireBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(wireBytes).toBeGreaterThan(64 * 1024);
    expect(wireBytes).toBeLessThanOrEqual(GENERATE_MAX_BODY_BYTES);
    const res = await v1Generate(v1Req(body));
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toMatch(/generation failed/i);
  });
});
