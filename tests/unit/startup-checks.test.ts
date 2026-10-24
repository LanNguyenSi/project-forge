import { describe, expect, it } from "vitest";
import { assertSecretsConfigured, findSecretProblems } from "@/lib/startup-checks";

describe("findSecretProblems", () => {
  it("accepts a real secret", () => {
    expect(findSecretProblems({ NEXTAUTH_SECRET: "a".repeat(64) })).toEqual([]);
  });

  it("rejects a missing secret", () => {
    expect(findSecretProblems({})).toHaveLength(1);
  });

  it("rejects an empty or whitespace-only secret", () => {
    expect(findSecretProblems({ NEXTAUTH_SECRET: "" })).toHaveLength(1);
    expect(findSecretProblems({ NEXTAUTH_SECRET: "   " })).toHaveLength(1);
  });

  it("rejects the .env.example placeholder", () => {
    expect(
      findSecretProblems({
        NEXTAUTH_SECRET: "your-secret-here-generate-with-openssl-rand-hex-32",
      }),
    ).toHaveLength(1);
  });

  it("rejects the override example placeholder", () => {
    expect(
      findSecretProblems({
        NEXTAUTH_SECRET: "your_nextauth_secret_here-generate-with-openssl-rand-hex-32",
      }),
    ).toHaveLength(1);
  });

  it("rejects a placeholder that only carries the generate hint", () => {
    expect(findSecretProblems({ NEXTAUTH_SECRET: "changeme-generate-with-openssl" })).toHaveLength(1);
  });

  it("does not flag a random secret that merely starts with other text", () => {
    expect(findSecretProblems({ NEXTAUTH_SECRET: "yours3cr3tvalue0123456789abcdef" })).toEqual([]);
  });
});

describe("assertSecretsConfigured", () => {
  it("does not throw for a real secret", () => {
    expect(() => assertSecretsConfigured({ NEXTAUTH_SECRET: "f".repeat(64) })).not.toThrow();
  });

  it("throws a start-refusal naming the variable", () => {
    expect(() => assertSecretsConfigured({})).toThrow(/Refusing to start: NEXTAUTH_SECRET/);
  });
});
