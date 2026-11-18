import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github-pat", () => ({ startLegacyGithubPatSweep: vi.fn() }));

import { register } from "@/instrumentation";
import { startLegacyGithubPatSweep } from "@/lib/github-pat";

const mSweep = vi.mocked(startLegacyGithubPatSweep);

const PLACEHOLDER = "your-secret-here-generate-with-openssl-rand-hex-32";
const URL_PLACEHOLDER = "https://your-forge.example.com";

function stubServerEnv(overrides: Record<string, string>) {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  vi.stubEnv("NEXTAUTH_SECRET", PLACEHOLDER);
  vi.stubEnv("NEXTAUTH_URL", URL_PLACEHOLDER);
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

describe("instrumentation register()", () => {
  beforeEach(() => {
    mSweep.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to serve with the placeholder secret", async () => {
    stubServerEnv({});
    await expect(register()).rejects.toThrow(/Refusing to serve/);
  });

  it("refuses to serve without a secret", async () => {
    stubServerEnv({ NEXTAUTH_SECRET: "" });
    await expect(register()).rejects.toThrow(/NEXTAUTH_SECRET is not set/);
  });

  it("boots the production server with a real secret", async () => {
    stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: "https://forge.example.com" });
    await expect(register()).resolves.toBeUndefined();
  });

  it("refuses to serve with the placeholder NEXTAUTH_URL", async () => {
    stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: URL_PLACEHOLDER });
    await expect(register()).rejects.toThrow(/NEXTAUTH_URL is still the placeholder/);
  });

  it("refuses to serve without NEXTAUTH_URL", async () => {
    stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: "" });
    await expect(register()).rejects.toThrow(/NEXTAUTH_URL is not set/);
  });

  it("refuses to serve with a NEXTAUTH_URL that NextAuth cannot parse", async () => {
    stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: "https://" });
    await expect(register()).rejects.toThrow(/NEXTAUTH_URL is not a valid URL/);
  });

  it("does not check outside production (dev server, tests)", async () => {
    stubServerEnv({ NODE_ENV: "development" });
    await expect(register()).resolves.toBeUndefined();
  });

  it("does not check during next build", async () => {
    stubServerEnv({ NEXT_PHASE: "phase-production-build" });
    await expect(register()).resolves.toBeUndefined();
  });

  it("does not check in the edge runtime", async () => {
    stubServerEnv({ NEXT_RUNTIME: "edge" });
    await expect(register()).resolves.toBeUndefined();
  });

  describe("legacy GitHub token sweep", () => {
    it("is started once after the checks pass on the production server", async () => {
      stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: "https://forge.example.com" });
      await register();
      expect(mSweep).toHaveBeenCalledTimes(1);
    });

    it("is not started when the start-up check refuses to serve", async () => {
      stubServerEnv({});
      await expect(register()).rejects.toThrow(/Refusing to serve/);
      expect(mSweep).not.toHaveBeenCalled();
    });

    it("is not started when the check refuses to serve over NEXTAUTH_URL (the key material is fine)", async () => {
      stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: URL_PLACEHOLDER });
      await expect(register()).rejects.toThrow(/NEXTAUTH_URL/);
      expect(mSweep).not.toHaveBeenCalled();
    });

    it("is not started when the key check refuses to serve", async () => {
      stubServerEnv({
        NEXTAUTH_SECRET: "c".repeat(64),
        NEXTAUTH_URL: "https://forge.example.com",
        GITHUB_PAT_ENCRYPTION_KEY: "short",
      });
      await expect(register()).rejects.toThrow(/GITHUB_PAT_ENCRYPTION_KEY/);
      expect(mSweep).not.toHaveBeenCalled();
    });

    it("is started on the dev server with a real secret", async () => {
      stubServerEnv({ NODE_ENV: "development", NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: "" });
      await register();
      expect(mSweep).toHaveBeenCalledTimes(1);
    });

    it("is not started on the dev server with the placeholder secret", async () => {
      stubServerEnv({ NODE_ENV: "development" });
      await expect(register()).resolves.toBeUndefined();
      expect(mSweep).not.toHaveBeenCalled();
    });

    it("is not started on the dev server with a short or placeholder key", async () => {
      stubServerEnv({ NODE_ENV: "development", NEXTAUTH_SECRET: "c".repeat(64), GITHUB_PAT_ENCRYPTION_KEY: "short" });
      await register();
      stubServerEnv({
        NODE_ENV: "development",
        NEXTAUTH_SECRET: "c".repeat(64),
        GITHUB_PAT_ENCRYPTION_KEY: "your-key-generate-with-openssl-rand-hex-32",
      });
      await register();
      expect(mSweep).not.toHaveBeenCalled();
    });

    it("is not started under the test runner, during next build or in the edge runtime, even with real key material", async () => {
      const real = { NEXTAUTH_SECRET: "c".repeat(64), NEXTAUTH_URL: "https://forge.example.com" };
      stubServerEnv({ ...real, NODE_ENV: "test" });
      await register();
      stubServerEnv({ ...real, NEXT_PHASE: "phase-production-build" });
      await register();
      stubServerEnv({ ...real, NEXT_RUNTIME: "edge" });
      await register();
      expect(mSweep).not.toHaveBeenCalled();
    });
  });
});
