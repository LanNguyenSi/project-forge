import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

/**
 * Gives every test file its own session root. The routes read FORGE_TEMP_DIR
 * at module load and fall back to the shared /tmp/project-forge, so two files
 * that picked the same session id raced on one directory (a publish marker
 * written by one file turned the other's 200 into a 409). Setup files run
 * once per test file before its imports, so the env is in place when the
 * routes load. A file that sets FORGE_TEMP_DIR itself still wins.
 */
if (!process.env.FORGE_TEMP_DIR) {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-test-"));
  process.env.FORGE_TEMP_DIR = dir;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}
