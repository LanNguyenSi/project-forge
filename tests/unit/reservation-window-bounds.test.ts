import { describe, expect, it } from "vitest";
import {
  RESERVATION_TTL_MS,
  GENERATION_TIMEOUT_MS,
  GITHUB_REPO_CREATE_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
} from "@/lib/db";
import { AI_REQUEST_TIMEOUT_MS, AI_MAX_RETRIES } from "@/lib/ai-provider";

/**
 * The reservation invariant of lib/db.ts: every outbound call a publishing
 * request makes between reserveUsage() and confirmUsage()/releaseUsage() is
 * bounded, and the worst case of the SLOWEST route (POST /api/v1/projects:
 * planforge generation, post-scaffold AI review, GitHub repo create, git
 * push) stays below RESERVATION_TTL_MS with at least 2 minutes of margin.
 * The sum is computed here from the exported constants themselves, so
 * raising one of them (or shrinking the TTL) fails this test, exactly like
 * the comment next to RESERVATION_TTL_MS says.
 * POST /api/v1/publish is strictly cheaper (no generation, no AI review),
 * so bounding the slowest route bounds both.
 */

// Git invocations createAndPushRepo runs at the default timeout on the
// projects route: init, config x2, add, commit, branch, remote. The push
// itself runs at GIT_PUSH_TIMEOUT_MS.
const GIT_COMMANDS_AT_DEFAULT_TIMEOUT = 7;

const worstCaseMs =
  GENERATION_TIMEOUT_MS +
  AI_REQUEST_TIMEOUT_MS * (1 + AI_MAX_RETRIES) +
  GITHUB_REPO_CREATE_TIMEOUT_MS +
  GIT_COMMAND_TIMEOUT_MS * GIT_COMMANDS_AT_DEFAULT_TIMEOUT +
  GIT_PUSH_TIMEOUT_MS;

describe("reservation window bounds", () => {
  it("every bound is a positive number", () => {
    for (const ms of [
      GENERATION_TIMEOUT_MS,
      AI_REQUEST_TIMEOUT_MS,
      GITHUB_REPO_CREATE_TIMEOUT_MS,
      GIT_COMMAND_TIMEOUT_MS,
      GIT_PUSH_TIMEOUT_MS,
      RESERVATION_TTL_MS,
    ]) {
      expect(Number.isFinite(ms) && ms > 0).toBe(true);
    }
    expect(Number.isInteger(AI_MAX_RETRIES) && AI_MAX_RETRIES >= 0).toBe(true);
  });

  it("keeps the slowest route's worst case inside the reservation TTL with at least 2 minutes of margin", () => {
    expect(worstCaseMs).toBeLessThan(RESERVATION_TTL_MS);
    expect(RESERVATION_TTL_MS - worstCaseMs).toBeGreaterThanOrEqual(2 * 60_000);
  });
});
