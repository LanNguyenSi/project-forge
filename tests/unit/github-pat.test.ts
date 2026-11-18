import { describe, expect, it, vi } from "vitest";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { decryptGithubPat, encryptGithubPat, isEncryptedGithubPat, readGithubPat } from "@/lib/github-pat";

const KEY = "k".repeat(64);
const SECRET = "s".repeat(64);
const OTHER_SECRET = "t".repeat(64);
const TOKEN = "gho_exampleToken123";

function parts(stored: string) {
  const [version, iv, tag, ciphertext] = stored.split(":");
  return { version, iv, tag, ciphertext };
}

// Flips the first byte of one base64url part and puts the value back together.
function tamper(stored: string, index: 1 | 2 | 3): string {
  const split = stored.split(":");
  const bytes = Buffer.from(split[index], "base64url");
  bytes[0] ^= 0x01;
  split[index] = bytes.toString("base64url");
  return split.join(":");
}

describe("encryptGithubPat / decryptGithubPat", () => {
  const env = { NEXTAUTH_SECRET: SECRET };

  it("round trips a token", () => {
    const stored = encryptGithubPat(TOKEN, env);
    expect(decryptGithubPat(stored, env)).toBe(TOKEN);
  });

  it("stores v1:<iv>:<tag>:<ciphertext> in base64url, without the token in it", () => {
    const stored = encryptGithubPat(TOKEN, env);
    expect(stored).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain(TOKEN);
    const p = parts(stored);
    expect(Buffer.from(p.iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(p.tag, "base64url")).toHaveLength(16);
    expect(isEncryptedGithubPat(stored)).toBe(true);
  });

  it("uses a random IV: two encryptions of the same token differ", () => {
    const a = encryptGithubPat(TOKEN, env);
    const b = encryptGithubPat(TOKEN, env);
    expect(a).not.toBe(b);
    expect(parts(a).iv).not.toBe(parts(b).iv);
    expect(decryptGithubPat(a, env)).toBe(TOKEN);
    expect(decryptGithubPat(b, env)).toBe(TOKEN);
  });

  it("fails closed on a tampered IV", () => {
    expect(decryptGithubPat(tamper(encryptGithubPat(TOKEN, env), 1), env)).toBeNull();
  });

  it("fails closed on a tampered auth tag", () => {
    expect(decryptGithubPat(tamper(encryptGithubPat(TOKEN, env), 2), env)).toBeNull();
  });

  it("fails closed on a tampered ciphertext", () => {
    expect(decryptGithubPat(tamper(encryptGithubPat(TOKEN, env), 3), env)).toBeNull();
  });

  it("fails closed on a wrong key", () => {
    const stored = encryptGithubPat(TOKEN, env);
    expect(decryptGithubPat(stored, { NEXTAUTH_SECRET: OTHER_SECRET })).toBeNull();
  });

  it("fails closed on malformed values", () => {
    const stored = encryptGithubPat(TOKEN, env);
    const p = parts(stored);
    expect(decryptGithubPat("v1:", env)).toBeNull();
    expect(decryptGithubPat(`v1:${p.iv}:${p.tag}`, env)).toBeNull();
    expect(decryptGithubPat(`${stored}:extra`, env)).toBeNull();
    expect(decryptGithubPat(`v1:${p.iv}:${p.tag}:`, env)).toBeNull();
    expect(decryptGithubPat(`v1:AAAA:${p.tag}:${p.ciphertext}`, env)).toBeNull();
    expect(decryptGithubPat(`v1:${p.iv}:AAAA:${p.ciphertext}`, env)).toBeNull();
  });

  it("derives the AES key with HKDF-SHA256 and the purpose-specific info string", () => {
    const stored = encryptGithubPat(TOKEN, env);
    const p = parts(stored);
    const decrypt = (info: string) => {
      const key = Buffer.from(hkdfSync("sha256", SECRET, Buffer.alloc(0), info, 32));
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64url"));
      d.setAuthTag(Buffer.from(p.tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(p.ciphertext, "base64url")), d.final()]).toString("utf8");
    };
    expect(decrypt("project-forge github-pat aes-256-gcm v1")).toBe(TOKEN);
    // Any other derivation from the same secret is a different key.
    expect(() => decrypt("")).toThrow();
  });

  it("reads a value without the version prefix as legacy plaintext", () => {
    expect(decryptGithubPat("ghp_legacyPlain", env)).toBe("ghp_legacyPlain");
    expect(decryptGithubPat("gho_legacyPlain", {})).toBe("gho_legacyPlain");
    expect(isEncryptedGithubPat("ghp_legacyPlain")).toBe(false);
  });

  it("reads null, undefined and an empty string as not connected", () => {
    expect(decryptGithubPat(null, env)).toBeNull();
    expect(decryptGithubPat(undefined, env)).toBeNull();
    expect(decryptGithubPat("", env)).toBeNull();
  });
});

// Which input supplies the key. GITHUB_PAT_ENCRYPTION_KEY wins whenever it is
// non-empty; NEXTAUTH_SECRET is the fallback; neither means no key.
describe("key precedence", () => {
  it("key only: the key is used", () => {
    const stored = encryptGithubPat(TOKEN, { GITHUB_PAT_ENCRYPTION_KEY: KEY });
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY })).toBe(TOKEN);
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY, NEXTAUTH_SECRET: SECRET })).toBe(TOKEN);
    expect(decryptGithubPat(stored, { NEXTAUTH_SECRET: SECRET })).toBeNull();
  });

  it("secret only: NEXTAUTH_SECRET is used", () => {
    const stored = encryptGithubPat(TOKEN, { NEXTAUTH_SECRET: SECRET });
    expect(decryptGithubPat(stored, { NEXTAUTH_SECRET: SECRET })).toBe(TOKEN);
    // Setting a key later replaces the fallback: the stored value no longer reads.
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY, NEXTAUTH_SECRET: SECRET })).toBeNull();
  });

  it("both set: the key wins and NEXTAUTH_SECRET is ignored", () => {
    const stored = encryptGithubPat(TOKEN, { GITHUB_PAT_ENCRYPTION_KEY: KEY, NEXTAUTH_SECRET: SECRET });
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY })).toBe(TOKEN);
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY, NEXTAUTH_SECRET: OTHER_SECRET })).toBe(TOKEN);
    expect(decryptGithubPat(stored, { NEXTAUTH_SECRET: SECRET })).toBeNull();
  });

  it("neither set: encrypting throws, an encrypted value reads as not connected, legacy plaintext still reads", () => {
    const stored = encryptGithubPat(TOKEN, { NEXTAUTH_SECRET: SECRET });
    expect(() => encryptGithubPat(TOKEN, {})).toThrow(/GITHUB_PAT_ENCRYPTION_KEY \(or NEXTAUTH_SECRET\)/);
    expect(decryptGithubPat(stored, {})).toBeNull();
    expect(decryptGithubPat("ghp_legacyPlain", {})).toBe("ghp_legacyPlain");
  });

  it("empty key with a secret: the empty key counts as absent and NEXTAUTH_SECRET is used", () => {
    const stored = encryptGithubPat(TOKEN, { GITHUB_PAT_ENCRYPTION_KEY: "", NEXTAUTH_SECRET: SECRET });
    expect(decryptGithubPat(stored, { NEXTAUTH_SECRET: SECRET })).toBe(TOKEN);
  });

  it("empty key and empty secret: no key", () => {
    expect(() => encryptGithubPat(TOKEN, { GITHUB_PAT_ENCRYPTION_KEY: "", NEXTAUTH_SECRET: "" })).toThrow();
  });

  it("key with an empty secret: the key is used", () => {
    const stored = encryptGithubPat(TOKEN, { GITHUB_PAT_ENCRYPTION_KEY: KEY, NEXTAUTH_SECRET: "" });
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY })).toBe(TOKEN);
  });

  it("placeholder key: still used as the key (the production start-up check refuses it)", () => {
    const placeholder = "your-github-pat-key-here-generate-with-openssl-rand-hex-32";
    const stored = encryptGithubPat(TOKEN, { GITHUB_PAT_ENCRYPTION_KEY: placeholder, NEXTAUTH_SECRET: SECRET });
    expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: placeholder })).toBe(TOKEN);
    expect(decryptGithubPat(stored, { NEXTAUTH_SECRET: SECRET })).toBeNull();
  });

  it("reads process.env when no env is passed", () => {
    vi.stubEnv("GITHUB_PAT_ENCRYPTION_KEY", KEY);
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    try {
      const stored = encryptGithubPat(TOKEN);
      expect(decryptGithubPat(stored, { GITHUB_PAT_ENCRYPTION_KEY: KEY })).toBe(TOKEN);
      expect(decryptGithubPat(stored)).toBe(TOKEN);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("readGithubPat", () => {
  function client() {
    return { user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  }

  it("re-encrypts a legacy plaintext value with a compare-and-swap on the value read", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    try {
      const c = client();
      expect(await readGithubPat({ id: "u1", githubPat: "ghp_legacyPlain" }, c)).toBe("ghp_legacyPlain");
      expect(c.user.updateMany).toHaveBeenCalledTimes(1);
      const args = c.user.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ id: "u1", githubPat: "ghp_legacyPlain" });
      expect(args.data.githubPat).toMatch(/^v1:/);
      expect(decryptGithubPat(args.data.githubPat)).toBe("ghp_legacyPlain");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not write for an encrypted value", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    try {
      const c = client();
      expect(await readGithubPat({ id: "u1", githubPat: encryptGithubPat(TOKEN) }, c)).toBe(TOKEN);
      expect(c.user.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns null and does not write for a value that does not decrypt", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    try {
      const c = client();
      const stored = encryptGithubPat(TOKEN, { NEXTAUTH_SECRET: OTHER_SECRET });
      expect(await readGithubPat({ id: "u1", githubPat: stored }, c)).toBeNull();
      expect(await readGithubPat({ id: "u1", githubPat: null }, c)).toBeNull();
      expect(c.user.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still returns a legacy token when no key is set, and leaves the row as it is", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    vi.stubEnv("GITHUB_PAT_ENCRYPTION_KEY", "");
    try {
      const c = client();
      expect(await readGithubPat({ id: "u1", githubPat: "ghp_legacyPlain" }, c)).toBe("ghp_legacyPlain");
      expect(c.user.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns the token and logs nothing when the rewrite fails", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    try {
      const c = { user: { updateMany: vi.fn().mockRejectedValue(new Error("database is locked ghp_legacyPlain")) } };
      expect(await readGithubPat({ id: "u1", githubPat: "ghp_legacyPlain" }, c)).toBe("ghp_legacyPlain");
      for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      for (const spy of logs) spy.mockRestore();
    }
  });
});
