/**
 * Bounded JSON body reader for API routes.
 *
 * `await req.json()` buffers the whole request body into memory before
 * any size check runs, so any unauthenticated route that calls it lets
 * a caller force arbitrarily large allocations. This helper caps the
 * read two ways:
 *
 * 1. A declared `Content-Length` above the cap is rejected up front,
 *    without touching the body stream.
 * 2. Otherwise the stream is consumed incrementally and the read is
 *    aborted as soon as the running byte count crosses the cap, so a
 *    missing or lying Content-Length cannot bypass the limit.
 *
 * Invalid JSON is not handled here: the parsed text goes through
 * `JSON.parse`, whose SyntaxError propagates so each route keeps the
 * invalid-JSON response it already answers with today.
 */

/**
 * Thrown when the body exceeds the cap. Routes map it to a 413 in
 * their own `{ ok: false, error }` shape.
 */
export class BodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  // A numeric Content-Length over the cap: reject without reading. A
  // missing or non-numeric one (Number(null) === 0, garbage === NaN)
  // falls through to the streaming check, which is authoritative.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        // Stop pulling before buffering (or parsing) the rest.
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }

  // No body (or an empty one) lands on JSON.parse("") and throws the
  // same SyntaxError `req.json()` would have thrown.
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}
