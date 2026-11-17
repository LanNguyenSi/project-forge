import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Guard for the per-file session root set up in tests/setup/forge-temp-dir.ts.
// A test file that falls back to the shared /tmp/project-forge can collide
// with another file using the same session id.
describe("per-file FORGE_TEMP_DIR", () => {
  it("is set to a private directory, not the shared default", () => {
    const dir = process.env.FORGE_TEMP_DIR;
    expect(dir).toBeTruthy();
    expect(dir).not.toBe("/tmp/project-forge");
    expect(path.basename(dir as string)).toMatch(/^pf-test-/);
    expect(fs.statSync(dir as string).isDirectory()).toBe(true);
  });
});
