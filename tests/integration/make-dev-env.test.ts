// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `make dev-env` writes .env from .env.example with a generated
 * NEXTAUTH_SECRET, so the file it creates holds a secret and must never be
 * world-readable. A plain `cp` of the example gives the copy that example's
 * mode (644), so the recipe runs its shell under `umask 077`: .env.tmp is
 * created mode 600 before the secret is written into it, and `mv` keeps that
 * mode onto .env. The recipe is run here for real, with `make` and `openssl`,
 * in a temp directory holding copies of the Makefile and .env.example, so the
 * checkout's own .env is never touched.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function requireTool(name: string): void {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`these tests need ${name} on PATH`);
}
requireTool("make");
requireTool("openssl");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A copy of the two files the recipe reads, in an otherwise empty directory. */
function copyOf(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-make-dev-env-"));
  dirs.push(dir);
  copyFileSync(path.join(ROOT, "Makefile"), path.join(dir, "Makefile"));
  copyFileSync(path.join(ROOT, ".env.example"), path.join(dir, ".env.example"));
  return dir;
}

const runDevEnv = (dir: string) =>
  spawnSync("make", ["-C", dir, "dev-env"], {
    encoding: "utf-8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });

const mode = (p: string) => statSync(p).mode & 0o777;
const envIn = (dir: string) => readFileSync(path.join(dir, ".env"), "utf-8");

describe("make dev-env", () => {
  it("creates .env readable by its owner only, even though the example it copies is world-readable", () => {
    const dir = copyOf();
    // Precondition of the finding: the template (and the copy `cp` would make
    // of it) is world-readable. If this ever fails, the assertion below is no
    // longer the one that matters.
    expect(mode(path.join(dir, ".env.example")) & 0o044).not.toBe(0);

    const r = runDevEnv(dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(existsSync(path.join(dir, ".env"))).toBe(true);
    expect(mode(path.join(dir, ".env"))).toBe(0o600);
  });

  it("generates a 64 character hex NEXTAUTH_SECRET and the local NEXTAUTH_URL", () => {
    const dir = copyOf();
    expect(runDevEnv(dir).status).toBe(0);
    const env = envIn(dir);
    const secret = /^NEXTAUTH_SECRET=([^\n]*)$/m.exec(env)?.[1];
    // Length and shape only: the value is a secret and stays out of the output.
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(env).toMatch(/^NEXTAUTH_URL=http:\/\/localhost:3000$/m);
  });

  it("leaves no temporary file behind", () => {
    const dir = copyOf();
    expect(runDevEnv(dir).status).toBe(0);
    expect(readdirSync(dir).filter((f) => f.startsWith(".env.tmp"))).toEqual([]);
    // Only the two files the run is about: the example and the .env it created.
    expect(readdirSync(dir).filter((f) => f.startsWith(".env")).sort()).toEqual([".env", ".env.example"]);
  });

  it("changes nothing when .env already exists, not even its mode or modification time", () => {
    const dir = copyOf();
    expect(runDevEnv(dir).status).toBe(0);
    const file = path.join(dir, ".env");
    const before = { text: envIn(dir), mode: mode(file), mtimeMs: statSync(file).mtimeMs };

    const again = runDevEnv(dir);
    expect(again.status, again.stderr + again.stdout).toBe(0);
    expect(again.stdout).not.toMatch(/\.env created/);
    expect(mode(file)).toBe(before.mode);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(envIn(dir)).toBe(before.text);
  });
});
