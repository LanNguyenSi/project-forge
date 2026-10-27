// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * scripts/check-migrations.sh is the CI step that fails when prisma/schema.prisma
 * and prisma/migrations disagree. It runs here against the real prisma and a
 * fresh SQLite file; the schema and migrations are copies under a temp dir
 * (SCHEMA_PATH), so the repo is never touched.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-migrations.sh");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Copy of prisma/ (schema + migrations) that a test can edit. */
function prismaCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-check-migrations-"));
  dirs.push(dir);
  cpSync(path.join(ROOT, "prisma"), path.join(dir, "prisma"), { recursive: true });
  return path.join(dir, "prisma");
}

function check(schemaPath?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  if (schemaPath) env.SCHEMA_PATH = schemaPath;
  return spawnSync("sh", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    env: env as NodeJS.ProcessEnv,
  });
}

describe("scripts/check-migrations.sh", () => {
  it("passes for the committed schema and migrations", () => {
    const r = check();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("No difference detected");
  }, 120_000);

  it("fails when the schema has a field that no migration creates", () => {
    const prisma = prismaCopy();
    const schema = path.join(prisma, "schema.prisma");
    const text = readFileSync(schema, "utf-8");
    expect(text).toContain("  githubOwner  String?\n");
    writeFileSync(schema, text.replace("  githubOwner  String?\n", "  githubOwner  String?\n  nickname     String?\n"));
    const r = check(schema);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("nickname");
    expect(r.stderr).toContain("disagree");
  }, 120_000);

  it("fails when a migration creates something the schema does not describe", () => {
    const prisma = prismaCopy();
    const dir = path.join(prisma, "migrations", "20261028000000_extra");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "migration.sql"), 'CREATE TABLE "Extra" ("id" TEXT NOT NULL PRIMARY KEY);\n');
    const r = check(path.join(prisma, "schema.prisma"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("disagree");
  }, 120_000);

  it("passes when a schema change comes with its migration", () => {
    const prisma = prismaCopy();
    const schema = path.join(prisma, "schema.prisma");
    writeFileSync(schema, readFileSync(schema, "utf-8") + "\nmodel Extra {\n  id String @id\n}\n");
    const dir = path.join(prisma, "migrations", "20261028000000_extra");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "migration.sql"), 'CREATE TABLE "Extra" ("id" TEXT NOT NULL PRIMARY KEY);\n');
    const r = check(schema);
    expect(r.status, r.stderr + r.stdout).toBe(0);
  }, 120_000);
});
