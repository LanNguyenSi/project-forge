// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AI_ASSIST_MAX_BODY_BYTES, FILE_MODE_MAX_CHARS, PROMPT_MODE_MAX_CHARS } from "@/lib/limits";

/**
 * Size-limit coverage for POST /api/ai-assist: the new prompt-mode cap
 * (prompt mode previously had no limit at all, while file mode already
 * 413'd at 50k chars) and the request-body byte cap.
 */

function mockSession(session: unknown) {
  vi.doMock("next-auth", () => ({
    getServerSession: vi.fn().mockResolvedValue(session),
  }));
  vi.doMock("@/lib/auth", () => ({ authOptions: {} }));
}

let generateMock: ReturnType<typeof vi.fn>;

function mockProvider() {
  generateMock = vi.fn(async () => ({
    provider: "local" as const,
    model: "qwen-local",
    data: {
      projectName: "extracted-app",
      summary: "Extracted summary.",
      features: ["a", "b"],
      constraints: [],
      targetUsers: ["users"],
    },
  }));
  vi.doMock("@/lib/ai-provider", () => ({
    getAiCapabilities: () => ({
      enabled: true,
      provider: "local",
      model: "qwen-local",
      features: { magicFill: true, intakeEnrichment: true },
      maxContextChars: 50_000,
    }),
    generateStructuredJson: generateMock,
  }));
}

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/ai-assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai-assist size limits", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("accepts a prompt of exactly PROMPT_MODE_MAX_CHARS (boundary)", async () => {
    mockSession({ user: { id: "user-1" } });
    mockProvider();
    const { POST } = await import("../../app/api/ai-assist/route");
    const res = await POST(jsonReq({ mode: "prompt", prompt: "x".repeat(PROMPT_MODE_MAX_CHARS) }));
    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("413 on a prompt of PROMPT_MODE_MAX_CHARS + 1, in file mode's 413 shape", async () => {
    mockSession({ user: { id: "user-1" } });
    mockProvider();
    const { POST } = await import("../../app/api/ai-assist/route");
    const res = await POST(jsonReq({ mode: "prompt", prompt: "x".repeat(PROMPT_MODE_MAX_CHARS + 1) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok: boolean; error: string; details?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/prompt/i);
    expect(body.details).toMatch(/10,001/);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("413 before any LLM call when the raw body exceeds AI_ASSIST_MAX_BODY_BYTES", async () => {
    // 370k chars of fileContent: over the derived 361,712-byte body cap.
    // The body cap fires inside the read, before the 50k file-mode char
    // check could, so the answer is the body-too-large shape.
    expect(370_000 + 30).toBeGreaterThan(AI_ASSIST_MAX_BODY_BYTES);
    mockSession({ user: { id: "user-1" } });
    mockProvider();
    const { POST } = await import("../../app/api/ai-assist/route");
    const res = await POST(jsonReq({ mode: "file", fileName: "huge.md", fileContent: "x".repeat(370_000) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/body too large/i);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("session gate still runs first: 401 (not 413) for an oversized body without a session", async () => {
    mockSession(null);
    mockProvider();
    const { POST } = await import("../../app/api/ai-assist/route");
    const res = await POST(jsonReq({ mode: "file", fileContent: "x".repeat(370_000) }));
    expect(res.status).toBe(401);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("accepts a legitimate maximal file-mode body far above 64 KiB on the wire", async () => {
    // 50k chars of U+0001 (the worst-case JSON escape, 6 bytes each)
    // plus a 200-char filename: every field exactly at its char cap, so
    // the wire body is ~300 KB, 4.5x over the 64 KiB default cap but
    // under the derived AI_ASSIST_MAX_BODY_BYTES. This pins that the
    // route reads with the derived cap, not a flat 64 KiB one.
    const body = {
      mode: "file" as const,
      fileName: "d".repeat(200),
      fileContent: "\u0001".repeat(FILE_MODE_MAX_CHARS),
    };
    const wireBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(wireBytes).toBeGreaterThan(64 * 1024);
    expect(wireBytes).toBeLessThanOrEqual(AI_ASSIST_MAX_BODY_BYTES);
    mockSession({ user: { id: "user-1" } });
    mockProvider();
    const { POST } = await import("../../app/api/ai-assist/route");
    const res = await POST(jsonReq(body));
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
