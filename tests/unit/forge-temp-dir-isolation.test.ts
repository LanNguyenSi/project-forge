import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

// Guard for the per-file session root set up in tests/setup/forge-temp-dir.ts.
// A test file that falls back to the shared /tmp/project-forge can collide
// with another file using the same session id.
describe("per-file FORGE_TEMP_DIR", () => {
  it("is set to a private directory, not the shared default", () => {
    const dir = process.env.FORGE_TEMP_DIR;
    expect(dir).toBeTruthy();
    // The setup overrides any FORGE_TEMP_DIR exported in the shell; a
    // conditional setup would leave the shared directory in place here.
    expect(dir, "setup must always set a private FORGE_TEMP_DIR, even when one is exported").not.toBe("/tmp/project-forge");
    expect(path.basename(dir as string)).toMatch(/^pf-test-/);
    expect(fs.statSync(dir as string).isDirectory()).toBe(true);
  });
});

describe("per-file FORGE_TEMP_DIR cleanup", () => {
  it("removes the private directory after the file ran", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-cleanup-check-"));
    try {
      const res = spawnSync(
        "npx",
        ["vitest", "run", "tests/unit/forge-temp-dir-isolation.test.ts", "-t", "is set to a private directory"],
        { env: { ...process.env, TMPDIR: tmp }, encoding: "utf-8", timeout: 60_000 },
      );
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(fs.readdirSync(tmp).filter((n) => n.startsWith("pf-test-"))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});
