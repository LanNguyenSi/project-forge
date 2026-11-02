import { describe, expect, it } from "vitest";
import { assertSecretsConfigured, findSecretProblems } from "@/lib/startup-checks";

describe("findSecretProblems", () => {
  it("accepts a real secret", () => {
    expect(
      findSecretProblems({
        NEXTAUTH_SECRET: "a".repeat(64),
        NEXTAUTH_URL: "https://forge.example.com",
      }),
    ).toEqual([]);
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

  it("rejects a your-prefixed placeholder without the generate hint", () => {
    expect(findSecretProblems({ NEXTAUTH_SECRET: "your-secret-here" })).toHaveLength(1);
    expect(findSecretProblems({ NEXTAUTH_SECRET: "YOUR_SECRET" })).toHaveLength(1);
  });

  it("does not flag a random secret that merely starts with other text", () => {
    expect(
      findSecretProblems({
        NEXTAUTH_SECRET: "yours3cr3tvalue0123456789abcdef",
        NEXTAUTH_URL: "https://forge.example.com",
      }),
    ).toEqual([]);
  });
});

describe("NEXTAUTH_URL", () => {
  const realSecret = { NEXTAUTH_SECRET: "a".repeat(64) };
  const withUrl = (extra: Record<string, string | undefined>) => findSecretProblems({ ...realSecret, ...extra });
  const notSet = [expect.stringContaining("NEXTAUTH_URL is not set")];
  const notValid = [expect.stringContaining("NEXTAUTH_URL is not a valid URL")];
  const placeholder = [expect.stringContaining("NEXTAUTH_URL is still the placeholder")];

  describe("missing value", () => {
    it("refuses when absent", () => {
      expect(withUrl({})).toEqual(notSet);
    });

    it("refuses when empty", () => {
      expect(withUrl({ NEXTAUTH_URL: "" })).toEqual(notSet);
    });

    it("refuses when whitespace only", () => {
      expect(withUrl({ NEXTAUTH_URL: "   " })).toEqual(notSet);
    });

    it("accepts when absent and AUTH_TRUST_HOST is set", () => {
      expect(withUrl({ AUTH_TRUST_HOST: "true" })).toEqual([]);
    });

    it("accepts when absent and VERCEL is set", () => {
      expect(withUrl({ VERCEL: "1" })).toEqual([]);
    });

    it("refuses when absent and AUTH_TRUST_HOST is empty", () => {
      expect(withUrl({ AUTH_TRUST_HOST: "" })).toEqual(notSet);
    });

    it("refuses when absent and VERCEL is empty, even with AUTH_TRUST_HOST (NextAuth: VERCEL wins when set)", () => {
      expect(withUrl({ VERCEL: "", AUTH_TRUST_HOST: "true" })).toEqual(notSet);
    });

    it("still validates a present value when AUTH_TRUST_HOST is set", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://", AUTH_TRUST_HOST: "true" })).toEqual(notValid);
    });
  });

  describe("placeholder host", () => {
    it("refuses https://your-forge.example.com", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://your-forge.example.com" })).toEqual(placeholder);
    });

    it("refuses the placeholder host in any case with a trailing slash", () => {
      expect(withUrl({ NEXTAUTH_URL: "HTTPS://YOUR-forge.example.com/" })).toEqual(placeholder);
    });

    it("accepts https://your-company.dev (other your- hosts are real)", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://your-company.dev" })).toEqual([]);
    });

    it("accepts https://your_app.example.org", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://your_app.example.org" })).toEqual([]);
    });

    it("accepts a host that contains generate-with-openssl", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://generate-with-openssl.example" })).toEqual([]);
    });
  });

  describe("values NextAuth accepts", () => {
    it("accepts a scheme-less host (NextAuth serves it as https)", () => {
      expect(withUrl({ NEXTAUTH_URL: "project-forge.opentriologue.ai" })).toEqual([]);
    });

    it("accepts a port and a path", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://forge.example.com:8443/forge" })).toEqual([]);
    });

    it("accepts http on localhost", () => {
      expect(withUrl({ NEXTAUTH_URL: "http://localhost:3000" })).toEqual([]);
    });

    it("accepts a plain https URL", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://forge.example.com" })).toEqual([]);
    });
  });

  describe("values NextAuth throws on", () => {
    it("refuses https:// without a host", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://" })).toEqual(notValid);
    });

    it("refuses a leading space (NextAuth builds https:// https://...)", () => {
      expect(withUrl({ NEXTAUTH_URL: " https://forge.example.com" })).toEqual(notValid);
    });

    it("refuses a trailing inline comment", () => {
      expect(withUrl({ NEXTAUTH_URL: "https://forge.example.com # comment" })).toEqual(notValid);
    });
  });

  it("reports the secret problem first when both values are bad", () => {
    expect(
      findSecretProblems({
        NEXTAUTH_SECRET: "your-secret-here-generate-with-openssl-rand-hex-32",
        NEXTAUTH_URL: "https://your-forge.example.com",
      }),
    ).toEqual([expect.stringContaining("NEXTAUTH_SECRET")]);
    expect(
      findSecretProblems({
        NEXTAUTH_SECRET: "",
        NEXTAUTH_URL: "https://",
      }),
    ).toEqual([expect.stringContaining("NEXTAUTH_SECRET is not set")]);
  });
});

describe("assertSecretsConfigured", () => {
  it("does not throw for a real secret", () => {
    expect(() =>
      assertSecretsConfigured({ NEXTAUTH_SECRET: "f".repeat(64), NEXTAUTH_URL: "https://forge.example.com" }),
    ).not.toThrow();
  });

  it("throws a refusal naming the variable", () => {
    expect(() => assertSecretsConfigured({})).toThrow(/Refusing to serve: NEXTAUTH_SECRET/);
  });

  it("throws a refusal naming NEXTAUTH_URL", () => {
    expect(() =>
      assertSecretsConfigured({ NEXTAUTH_SECRET: "f".repeat(64), NEXTAUTH_URL: "https://" }),
    ).toThrow(/Refusing to serve: NEXTAUTH_URL/);
  });
});
