import { describe, expect, it } from "vitest";
import {
  RESERVATION_TTL_MS,
  GENERATION_TIMEOUT_MS,
  GITHUB_REPO_CREATE_TIMEOUT_MS,
  GIT_COMMAND_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
  AI_CALLS_ON_SLOWEST_ROUTE,
  GIT_COMMANDS_AT_DEFAULT_TIMEOUT,
} from "@/lib/db";
import { AI_REQUEST_TIMEOUT_MS, AI_MAX_RETRIES } from "@/lib/ai-provider";

/**
 * The reservation invariant of lib/db.ts: every outbound call a publishing
 * request makes between reserveUsage() and confirmUsage()/releaseUsage() is
 * bounded, and the worst case of the SLOWEST route (POST /api/v1/projects:
 * planforge generation, the intake-enrichment and post-scaffold AI calls,
 * GitHub repo create, git push) stays below RESERVATION_TTL_MS with at least
 * 2 minutes of margin. The sum is computed here from the exported constants
 * themselves, so raising one of them (or shrinking the TTL) fails this test,
 * exactly like the comment next to RESERVATION_TTL_MS says.
 * POST /api/v1/publish is strictly cheaper (no generation, no AI call),
 * so bounding the slowest route bounds both.
 *
 * The margin cannot see a count that is too LOW (halving the AI term still
 * leaves a big margin), so both counts are pinned to the code elsewhere:
 * tests/integration/usage-reservation-routes.test.ts asserts the git calls
 * each route actually makes against GIT_COMMANDS_AT_DEFAULT_TIMEOUT, and
 * tests/integration/projects-route-ai-call-count.test.ts asserts the
 * generateStructuredJson() calls of the projects route against
 * AI_CALLS_ON_SLOWEST_ROUTE.
 */

const worstCaseMs =
  GENERATION_TIMEOUT_MS +
  AI_CALLS_ON_SLOWEST_ROUTE * AI_REQUEST_TIMEOUT_MS * (1 + AI_MAX_RETRIES) +
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
    expect(Number.isInteger(AI_CALLS_ON_SLOWEST_ROUTE) && AI_CALLS_ON_SLOWEST_ROUTE >= 1).toBe(true);
    expect(Number.isInteger(GIT_COMMANDS_AT_DEFAULT_TIMEOUT) && GIT_COMMANDS_AT_DEFAULT_TIMEOUT >= 1).toBe(true);
  });

  it("counts the AI calls of the slowest route as their own term", () => {
    // The slowest route reaches generateStructuredJson() twice: buildPlanforgeInput
    // -> enrichIntake before the planforge call, and the post-scaffold review
    // after it. Each call is AI_REQUEST_TIMEOUT_MS * (1 + AI_MAX_RETRIES), so
    // the AI term is AI_CALLS_ON_SLOWEST_ROUTE times that, and the sum below
    // is exactly the five terms the comment next to RESERVATION_TTL_MS lists.
    // This pins the SHAPE of the sum, not the counts: a count that is too low
    // stays inside the margin, so it is pinned to the code by
    // tests/integration/projects-route-ai-call-count.test.ts.
    const oneAiCallMs = AI_REQUEST_TIMEOUT_MS * (1 + AI_MAX_RETRIES);
    expect(oneAiCallMs).toBe(90000);
    const termsWithoutAi =
      GENERATION_TIMEOUT_MS +
      GITHUB_REPO_CREATE_TIMEOUT_MS +
      GIT_COMMAND_TIMEOUT_MS * GIT_COMMANDS_AT_DEFAULT_TIMEOUT +
      GIT_PUSH_TIMEOUT_MS;
    expect(worstCaseMs).toBe(termsWithoutAi + AI_CALLS_ON_SLOWEST_ROUTE * oneAiCallMs);
  });

  it("keeps the slowest route's worst case inside the reservation TTL with at least 2 minutes of margin", () => {
    expect(worstCaseMs).toBeLessThan(RESERVATION_TTL_MS);
    expect(RESERVATION_TTL_MS - worstCaseMs).toBeGreaterThanOrEqual(2 * 60_000);
  });
});
