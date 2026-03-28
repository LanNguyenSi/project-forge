import { describe, expect, it } from "vitest";
import { __internal } from "../../lib/post-scaffold-review";

describe("post-scaffold review helpers", () => {
  it("flags weak blueprint confidence as review-recommended", () => {
    const checks = __internal.buildDeterministicChecks(
      {
        blueprint: "rest-api",
        blueprintConfidence: "weak",
        agentMustCreateStructure: true,
      },
      {
        topLevelPaths: ["src"],
        samplePaths: ["src/main.py"],
      }
    );

    const verdict = __internal.summarizeDeterministicVerdict(checks);

    expect(checks.some((check) => check.status === "warn")).toBe(true);
    expect(verdict.status).toBe("review-recommended");
  });

  it("flags missing scaffold input as mismatch", () => {
    const checks = __internal.buildDeterministicChecks(null, {
      topLevelPaths: [],
      samplePaths: [],
    });

    const verdict = __internal.summarizeDeterministicVerdict(checks);

    expect(checks[0]?.status).toBe("fail");
    expect(verdict.status).toBe("mismatch");
  });
});
