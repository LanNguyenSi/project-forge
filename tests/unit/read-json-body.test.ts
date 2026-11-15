// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { BodyTooLargeError, readJsonBody } from "@/lib/read-json-body";

/**
 * Unit tests for the bounded JSON body reader. Node env on purpose:
 * the stream-limited paths need the real undici Request/ReadableStream,
 * not the DOM environment's stand-ins.
 */

const CAP = 1024;

function stringReq(body: string): NextRequest {
  return new NextRequest("http://test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/**
 * A minimal Request stand-in whose body arrives as a stream (so no
 * Content-Length is implied), optionally with a manually declared
 * Content-Length to simulate an honest or lying header. `bodyTouched`
 * flips the first time the helper reaches for `req.body` — the header
 * check must reject before that.
 *
 * A minimal object (not a real NextRequest) on purpose: undici's
 * Request constructor eagerly sniffs stream bodies, which would make
 * "the body was not touched" unobservable. readJsonBody only uses
 * `headers` and `body`.
 */
function streamingReq(
  totalBytes: number,
  chunkSize: number,
  contentLength?: string
): { req: Request; bodyTouched: () => boolean } {
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - produced);
      controller.enqueue(new Uint8Array(n));
      produced += n;
    },
  });
  let touched = false;
  const headers = new Headers(contentLength !== undefined ? { "Content-Length": contentLength } : {});
  const req = {
    headers,
    get body() {
      touched = true;
      return stream;
    },
  } as unknown as Request;
  return { req, bodyTouched: () => touched };
}

describe("readJsonBody", () => {
  it("resolves the parsed object for a body under the cap", async () => {
    const res = await readJsonBody(stringReq(JSON.stringify({ email: "a@b.com" })), CAP);
    expect(res).toEqual({ email: "a@b.com" });
  });

  it("resolves a body of exactly the cap bytes", async () => {
    const prefix = '{"a":"';
    const suffix = '"}';
    const pad = CAP - prefix.length - suffix.length;
    const body = prefix + "x".repeat(pad) + suffix;
    expect(new TextEncoder().encode(body).byteLength).toBe(CAP);
    await expect(readJsonBody(stringReq(body), CAP)).resolves.toEqual({ a: "x".repeat(pad) });
  });

  it("rejects when Content-Length exceeds the cap WITHOUT reading the body", async () => {
    // 2 KiB of stream behind a 999999 Content-Length: the header check
    // must fire before req.body is even touched. If the header check is
    // removed, the streamed check still throws below — but only after
    // reaching for the body, so bodyTouched() pins the no-read contract.
    const { req, bodyTouched } = streamingReq(2048, 512, "999999");
    await expect(readJsonBody(req, CAP)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(bodyTouched()).toBe(false);
  });

  it("rejects a stream over the cap when Content-Length is absent", async () => {
    const { req, bodyTouched } = streamingReq(2048, 512);
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readJsonBody(req, CAP)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(bodyTouched()).toBe(true);
  });

  it("a lying small Content-Length does not bypass the streamed check", async () => {
    const { req } = streamingReq(2048, 512, "10");
    await expect(readJsonBody(req, CAP)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("non-numeric Content-Length falls through to the streamed check", async () => {
    const { req } = streamingReq(2048, 512, "banana");
    await expect(readJsonBody(req, CAP)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("invalid JSON under the cap throws SyntaxError, not BodyTooLargeError", async () => {
    // Callers rely on this: the SyntaxError keeps each route answering
    // invalid JSON the way it does today.
    await expect(readJsonBody(stringReq("{not json"), CAP)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("an empty body throws SyntaxError like req.json() does", async () => {
    await expect(readJsonBody(stringReq(""), CAP)).rejects.toBeInstanceOf(SyntaxError);
  });
});
