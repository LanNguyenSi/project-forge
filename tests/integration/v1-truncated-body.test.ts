// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";

/**
 * Next cuts a middleware-cloned request body at
 * experimental.middlewareClientMaxBodySize and ends the stream cleanly, so
 * a chunked /api/v1 body above the limit reaches the route as an
 * unterminated JSON prefix. It must answer 413 like a body that declares
 * its Content-Length, not 500 with a SyntaxError in the log. The streams
 * below reproduce what the route saw on a real `next start`: 64 KiB
 * chunks, the chunk crossing the limit dropped, 589_824 bytes delivered.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: { usageLog: { create: vi.fn() } },
    validateApiToken: vi.fn(),
    reserveUsage: vi.fn(),
    confirmUsage: vi.fn().mockResolvedValue(undefined),
    releaseUsage: vi.fn().mockResolvedValue(undefined),
  };
});

import { validateApiToken, reserveUsage } from "@/lib/db";
import { POST as v1Generate } from "@/app/api/v1/generate/route";
import { POST as v1Projects } from "@/app/api/v1/projects/route";
import {
  GENERATE_MAX_BODY_BYTES,
  MIDDLEWARE_BODY_CLONE_LIMIT_BYTES,
} from "@/lib/limits";

const TOKEN_RECORD = { id: "tok-1", userId: "user-1", user: { githubPat: "ghp_x" } };
const CHUNK = 64 * 1024;

/** Chunked request (no Content-Length) delivering `bytes` in 64 KiB chunks. */
function chunkedReq(path: string, bytes: Uint8Array): NextRequest {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + CHUNK));
      offset += CHUNK;
    },
  });
  return new NextRequest(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "pf_test" },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
}

const enc = (s: string) => new TextEncoder().encode(s);
/** What Next delivers: whole 64 KiB chunks up to the clone limit, rest dropped. */
function cutAtCloneLimit(totalBytes: number): Uint8Array {
  const full = enc('{"projectName":"p","summary":"' + "a".repeat(totalBytes));
  const kept = Math.floor(MIDDLEWARE_BODY_CLONE_LIMIT_BYTES / CHUNK) * CHUNK;
  return full.slice(0, kept);
}

const routes = [
  ["/api/v1/generate", v1Generate],
  ["/api/v1/projects", v1Projects],
] as const;

describe.each(routes)("POST %s with a chunked body at the clone limit", (path, handler) => {
  let errorSpy: MockInstance<typeof console.error>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateApiToken).mockResolvedValue(TOKEN_RECORD as never);
    vi.mocked(reserveUsage).mockResolvedValue({ allowed: true, used: 0 } as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("sizes: the cut body is under the route cap, the case that answered 500", () => {
    const cut = cutAtCloneLimit(700_000);
    expect(cut.byteLength).toBe(589_824);
    expect(cut.byteLength).toBeLessThan(GENERATE_MAX_BODY_BYTES);
    expect(cut.byteLength).toBeLessThan(MIDDLEWARE_BODY_CLONE_LIMIT_BYTES);
  });

  it("413 for a chunked body above the clone limit (cut to 589_824 bytes)", async () => {
    const res = await handler(chunkedReq(path, cutAtCloneLimit(700_000)));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/body too large/i);
    const logged = errorSpy.mock.calls.flat();
    expect(logged.some((a: unknown) => a instanceof SyntaxError)).toBe(false);
  });

  it("413 for a chunked body just over the route cap that Next did not cut", async () => {
    const res = await handler(
      chunkedReq(path, enc('{"projectName":"p","summary":"' + "a".repeat(GENERATE_MAX_BODY_BYTES) + '"}'))
    );
    expect(res.status).toBe(413);
  });

  it("413 for a declared Content-Length above the cap, without reading the body", async () => {
    const req = new NextRequest(`http://test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "pf_test",
        "Content-Length": String(MIDDLEWARE_BODY_CLONE_LIMIT_BYTES + 1000),
      },
      body: "{}",
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  it("a small malformed chunked body is not a 413", async () => {
    const res = await handler(chunkedReq(path, enc("{not json")));
    expect(res.status).not.toBe(413);
  });
});
