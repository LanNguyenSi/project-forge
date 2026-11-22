// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATION_TIMEOUT_MS,
  GITHUB_REPO_CREATE_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  AI_CALLS_ON_SLOWEST_ROUTE,
  GIT_COMMANDS_AT_DEFAULT_TIMEOUT,
} from "@/lib/db";
import { AI_REQUEST_TIMEOUT_MS, AI_MAX_RETRIES } from "@/lib/ai-provider";

/**
 * `next start` is the container's main process (scripts/start.sh ends with
 * `exec "$@"`), and its SIGTERM handler stops accepting new connections and
 * waits for the requests already running before it exits, so a deploy drains
 * in-flight work up to the compose `stop_grace_period` of the service and
 * kills whatever is still running after it. The grace period therefore has to
 * cover the documented worst case of a request, which is the same sum the
 * comment next to RESERVATION_TTL_MS in lib/db.ts describes and
 * tests/unit/reservation-window-bounds.test.ts checks against the TTL: raising
 * a request timeout without raising the grace period would let a deploy cut
 * off a request that the timeouts allow, so this test recomputes the sum from
 * the exported constants and fails when the compose value drops below it.
 */

const root = path.resolve(__dirname, "../..");
// js-yaml arrives transitively (pinned through `overrides`) and ships no types
// here, so it is loaded with a minimal local signature (same as ops-config.test.ts).
const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };

type Obj = Record<string, unknown>;

const compose = load(readFileSync(path.join(root, "docker-compose.yml"), "utf-8")) as Obj;
const app = ((compose.services as Obj).app ?? {}) as Obj;

const worstCaseMs =
  GENERATION_TIMEOUT_MS +
  AI_CALLS_ON_SLOWEST_ROUTE * AI_REQUEST_TIMEOUT_MS * (1 + AI_MAX_RETRIES) +
  GITHUB_REPO_CREATE_TIMEOUT_MS +
  GIT_COMMAND_TIMEOUT_MS * GIT_COMMANDS_AT_DEFAULT_TIMEOUT +
  GIT_PUSH_TIMEOUT_MS;

/**
 * Compose duration of `stop_grace_period`: a bare number is seconds, otherwise
 * a `<n>h` / `<n>m` / `<n>s` combination (10m, 90s, 1h30m). Anything else is
 * rejected rather than read as 0, so a typo in the compose file fails the
 * guard instead of silently comparing against zero.
 */
function composeDurationMs(value: unknown, what: string): number {
  if (typeof value === "number") return value * 1000;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!parts || !(parts[1] || parts[2] || parts[3])) {
    throw new Error(`${what} is not a compose duration: ${JSON.stringify(value)}`);
  }
  return (Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)) * 1000;
}

describe("docker-compose.yml app stop_grace_period", () => {
  it("sets one on the app service", () => {
    expect(app).toHaveProperty("stop_grace_period");
  });

  it("is at least the documented worst case of the slowest publishing route, so a deploy cannot kill an in-flight request the timeouts still allow", () => {
    expect(composeDurationMs(app.stop_grace_period, "app.stop_grace_period")).toBeGreaterThanOrEqual(worstCaseMs);
  });

  it("leaves the planforge service at Docker's default (no stop_grace_period)", () => {
    const planforge = ((compose.services as Obj).planforge ?? {}) as Obj;
    expect(planforge).not.toHaveProperty("stop_grace_period");
  });
});

describe("composeDurationMs", () => {
  const ms = (v: unknown) => composeDurationMs(v, "value");

  it("reads a bare number as seconds", () => {
    expect(ms(600)).toBe(600_000);
    expect(ms("600")).toBe(600_000);
  });

  it("reads the unit suffixes s, m and h", () => {
    expect(ms("90s")).toBe(90_000);
    expect(ms("10m")).toBe(600_000);
    expect(ms("1h")).toBe(3_600_000);
  });

  it("reads a combination, and the hour part on its own", () => {
    expect(ms("1h30m")).toBe(5_400_000);
    expect(ms("2h30m45s")).toBe(9_045_000);
  });

  it("rejects anything that is not a compose duration, rather than reading it as 0", () => {
    for (const bad of ["", "10 x", "10 minutes", "d10m", "10mm", undefined, null, "m"]) {
      expect(() => ms(bad)).toThrow(/not a compose duration/);
    }
  });
});
