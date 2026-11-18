// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  BodyTooLargeError,
  CLONE_TRUNCATION_WINDOW_BYTES,
  readJsonBody,
} from "@/lib/read-json-body";

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

/**
 * A Request stand-in delivering `bytes` as a chunked stream (so no real
 * Content-Length is implied), optionally with a manually declared one.
 * The underlying source counts cancel() calls so a test can pin that an
 * aborted read cancels the reader instead of abandoning the stream.
 */
function streamingBytesReq(
  bytes: Uint8Array,
  chunkSize: number,
  contentLength?: string
): { req: Request; cancelCalls: () => number } {
  let offset = 0;
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() {
      cancels += 1;
    },
  });
  const headers = new Headers(contentLength !== undefined ? { "Content-Length": contentLength } : {});
  const req = { headers, body: stream } as unknown as Request;
  return { req, cancelCalls: () => cancels };
}

/** Valid JSON of exactly `totalBytes` bytes: {"a":"<pad>"} */
function jsonBytesOfLength(totalBytes: number): Uint8Array {
  const prefix = '{"a":"';
  const suffix = '"}';
  const pad = totalBytes - prefix.length - suffix.length;
  if (pad < 0) throw new Error(`totalBytes ${totalBytes} too small for the JSON shape`);
  return new TextEncoder().encode(prefix + "x".repeat(pad) + suffix);
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

  it("resolves a stream of exactly CAP bytes with an honest Content-Length of CAP", async () => {
    // The header boundary: Content-Length equal to the cap must pass.
    // If the header check used >=, this rejected without touching the
    // stream, and a legit request at exactly the cap could never be
    // sent through the declared-length path.
    const bytes = jsonBytesOfLength(CAP);
    const { req } = streamingBytesReq(bytes, 512, String(CAP));
    await expect(readJsonBody(req, CAP)).resolves.toEqual({ a: "x".repeat(CAP - 8) });
  });

  it("rejects CAP+1 streamed bytes with no Content-Length", async () => {
    // The stream boundary: one byte past the cap aborts. A checker that
    // tolerated an extra byte (received > maxBytes + 1) would resolve
    // this body instead of rejecting, so the 413 boundary is exactly
    // cap + 1.
    const bytes = jsonBytesOfLength(CAP + 1);
    const { req } = streamingBytesReq(bytes, 400);
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readJsonBody(req, CAP)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("cancels the reader when the streamed read aborts over the cap", async () => {
    // Abandoning the read without cancel() would leave the producer
    // running (and the socket draining) behind a rejected promise.
    const { req, cancelCalls } = streamingBytesReq(new Uint8Array(2048), 512);
    await expect(readJsonBody(req, CAP)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelCalls()).toBe(1);
  });
});

/**
 * Next cuts a middleware-cloned body at the clone limit and ends the
 * stream cleanly, so the route sees an unterminated JSON prefix that can
 * be shorter than its cap. Numbers mirror the real values: route cap
 * 601_712, clone limit 602_736, 64 KiB socket chunks.
 */
describe("readJsonBody with a middleware clone limit", () => {
  const ROUTE_CAP = 601_712;
  const CLONE_LIMIT = 602_736;
  const LOWER = CLONE_LIMIT - CLONE_TRUNCATION_WINDOW_BYTES;
  const opts = { cloneLimitBytes: CLONE_LIMIT };

  /** Unterminated JSON of exactly `n` bytes, as a cut-off body arrives. */
  function truncatedBytes(n: number): Uint8Array {
    return new TextEncoder().encode('{"a":"' + "x".repeat(n - 6));
  }

  it("reports a parse failure on a body ending just under the clone limit as too large", async () => {
    const { req } = streamingBytesReq(truncatedBytes(CLONE_LIMIT - 12_912), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, opts)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("the window's lower bound is inclusive: a cut ending exactly there is too large", async () => {
    const { req } = streamingBytesReq(truncatedBytes(LOWER), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, opts)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("one byte below the window it stays a SyntaxError", async () => {
    const { req } = streamingBytesReq(truncatedBytes(LOWER - 1), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, opts)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("a small malformed body stays a SyntaxError even with the clone limit set", async () => {
    await expect(readJsonBody(stringReq("{not json"), ROUTE_CAP, opts)).rejects.toBeInstanceOf(
      SyntaxError
    );
  });

  it("without the option the same cut-off body stays a SyntaxError", async () => {
    const { req } = streamingBytesReq(truncatedBytes(CLONE_LIMIT - 12_912), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("a valid body inside the window still resolves", async () => {
    const bytes = jsonBytesOfLength(ROUTE_CAP);
    const { req } = streamingBytesReq(bytes, 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, opts)).resolves.toEqual({
      a: "x".repeat(ROUTE_CAP - 8),
    });
  });

  it("a body over the route cap is still rejected by the byte count", async () => {
    const { req } = streamingBytesReq(jsonBytesOfLength(ROUTE_CAP + 1), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, opts)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  // Literal values, not derived from CLONE_TRUNCATION_WINDOW_BYTES: a test
  // that computes its cut from the constant moves with it and cannot tell
  // when the constant is shrunk.
  it("a cut 65_535 bytes below the clone limit is too large (largest gap one 64 KiB read leaves)", async () => {
    // 602_736 - 65_535 = 537_201 bytes delivered.
    const { req } = streamingBytesReq(truncatedBytes(537_201), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, { cloneLimitBytes: 602_736 })).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });

  it("a cut delivering 560_000 bytes (measured on a real server) is too large", async () => {
    const { req } = streamingBytesReq(truncatedBytes(560_000), 65_536);
    await expect(readJsonBody(req, ROUTE_CAP, { cloneLimitBytes: 602_736 })).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });

  it("the window is at least Node's 64 KiB HTTP read size", () => {
    // Node's HTTP parser hands the body over in chunks of at most 65_536
    // bytes, and the clone drops the whole chunk that crosses the limit, so
    // a truncated body can end up to 65_535 bytes short of it. A smaller
    // window would answer those bodies with a parse failure again.
    expect(CLONE_TRUNCATION_WINDOW_BYTES).toBeGreaterThanOrEqual(65_536);
  });
});
