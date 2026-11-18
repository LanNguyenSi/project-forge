// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GENERATE_MAX_BODY_BYTES, MIDDLEWARE_BODY_CLONE_LIMIT_BYTES } from "@/lib/limits";

/**
 * Next 15.5 clones every request body that passes through the middleware
 * up to experimental.middlewareClientMaxBodySize (default 10 MiB, see
 * node_modules/next/dist/server/config-shared.js) before the route runs,
 * and the middleware matcher covers /api/v1/*. next.config.mjs pins the
 * clone just above GENERATE_MAX_BODY_BYTES so the clone cannot exceed the
 * route caps in lib/limits.ts; the upper bound makes a later cap increase
 * without a config bump fail here.
 */
async function loadMiddlewareClientMaxBodySize(): Promise<number> {
  const nextConfig = (await import("../../next.config.mjs")).default;
  const value = nextConfig.experimental?.middlewareClientMaxBodySize;
  if (typeof value !== "number") {
    throw new Error("next.config.mjs does not set a numeric experimental.middlewareClientMaxBodySize");
  }
  return value;
}

describe("next.config.mjs experimental.middlewareClientMaxBodySize", () => {
  it("is above GENERATE_MAX_BODY_BYTES, so the clone never rejects a route-legal body", async () => {
    const value = await loadMiddlewareClientMaxBodySize();
    expect(value).toBeGreaterThan(GENERATE_MAX_BODY_BYTES);
  });

  it("equals MIDDLEWARE_BODY_CLONE_LIMIT_BYTES, the value readJsonBody uses to spot a cut-off body", async () => {
    const value = await loadMiddlewareClientMaxBodySize();
    expect(value).toBe(MIDDLEWARE_BODY_CLONE_LIMIT_BYTES);
  });

  it("is within 64 KiB above GENERATE_MAX_BODY_BYTES, so the clone stays bounded", async () => {
    const value = await loadMiddlewareClientMaxBodySize();
    expect(value).toBeLessThanOrEqual(GENERATE_MAX_BODY_BYTES + 64 * 1024);
  });
});
