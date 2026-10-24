import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";

const PLACEHOLDER = "your-secret-here-generate-with-openssl-rand-hex-32";

function stubServerEnv(overrides: Record<string, string>) {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  vi.stubEnv("NEXTAUTH_SECRET", PLACEHOLDER);
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

describe("instrumentation register()", () => {
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
    stubServerEnv({ NEXTAUTH_SECRET: "c".repeat(64) });
    await expect(register()).resolves.toBeUndefined();
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
});
