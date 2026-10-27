// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * scripts/start.sh decides how the container brings its SQLite database to the
 * committed schema before `next start`. The decision table is tested with a
 * stub `prisma` (records every call, exit codes come from the environment) and
 * a real `sqlite3` (a wrapper can make `.backup` fail). A second block runs the
 * script against the repo's own prisma and real SQLite files.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "start.sh");
const SCRIPT_TEXT = readFileSync(SCRIPT, "utf-8");
const BASELINE = /^BASELINE="([^"]+)"$/m.exec(SCRIPT_TEXT)?.[1] ?? "";

function realSqlite3(): string {
  const r = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf-8" });
  const p = r.stdout.trim();
  if (r.status !== 0 || !p) throw new Error("these tests need a sqlite3 binary on PATH");
  return p;
}
const SQLITE3 = realSqlite3();

/** The _prisma_migrations table exactly as prisma 5.22 creates it on SQLite. */
const MIGRATIONS_DDL =
  'CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0);';

const PRISMA_STUB = `#!/bin/sh
n=0
for f in "\${STUB_DB}".pre-migrate-*; do [ -e "$f" ] && n=$((n + 1)); done
echo "prisma $* [copies=$n]" >> "$STUB_LOG"
case "$1 $2" in
  "migrate status") exit "\${STUB_STATUS_RC:-0}" ;;
  "migrate diff") echo "stub diff output"; exit "\${STUB_DIFF_RC:-0}" ;;
  "migrate resolve") exit "\${STUB_RESOLVE_RC:-0}" ;;
  "migrate deploy")
    # Like a migration that fails halfway: prisma leaves a failed row behind
    # (on a new database it creates the history table first).
    if [ -n "\${STUB_DEPLOY_FAIL_ROW:-}" ]; then
      "$STUB_SQLITE3" "$STUB_DB" '${MIGRATIONS_DDL.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")}'
      "$STUB_SQLITE3" "$STUB_DB" "INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES (lower(hex(randomblob(8))), 'x', '\${STUB_DEPLOY_FAIL_ROW}', CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 500, 0)"
    fi
    exit "\${STUB_DEPLOY_RC:-0}" ;;
esac
echo "unexpected prisma call: $*" >&2
exit 99
`;

// Delegates to the real sqlite3, except that `.backup` fails when asked to.
const SQLITE_WRAPPER = `#!/bin/sh
case "$2" in
  .backup*) [ -n "\${STUB_BACKUP_FAIL:-}" ] && { echo "disk full" >&2; exit 1; } ;;
esac
exec "${SQLITE3}" "$@"
`;

const envFor = (e: Env): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

type Env = Record<string, string | undefined>;

interface Work {
  dir: string;
  db: string;
  log: string;
  marker: string;
  run: (env?: Env, args?: string[]) => SpawnSyncReturns<string>;
  calls: () => string[];
  copies: () => string[];
  sql: (file: string, statement: string) => string;
}

/** Adds prisma/migrations/<name>/migration.sql to a scratch /app (the image ships it). */
function addLocalMigration(dir: string, name: string, sql = "-- stub\n") {
  mkdirSync(path.join(dir, "prisma", "migrations", name), { recursive: true });
  writeFileSync(path.join(dir, "prisma", "migrations", name, "migration.sql"), sql);
}

/** A scratch working directory laid out like /app: prisma/, scripts/start.sh. */
function newWork(): Work {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-start-"));
  dirs.push(dir);
  addLocalMigration(dir, BASELINE);
  writeFileSync(path.join(dir, "prisma", "schema.prisma"), "// stub\n");
  mkdirSync(path.join(dir, "scripts"));
  copyFileSync(SCRIPT, path.join(dir, "scripts", "start.sh"));
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "prisma"), PRISMA_STUB);
  writeFileSync(path.join(dir, "bin", "sqlite3"), SQLITE_WRAPPER);
  chmodSync(path.join(dir, "bin", "prisma"), 0o755);
  chmodSync(path.join(dir, "bin", "sqlite3"), 0o755);
  const db = path.join(dir, "data", "project-forge.db");
  mkdirSync(path.dirname(db));
  const log = path.join(dir, "prisma.log");
  const marker = path.join(dir, "started");
  const sql = (file: string, statement: string) => {
    const r = spawnSync(SQLITE3, [file, statement], { encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  return {
    dir,
    db,
    log,
    marker,
    sql,
    run: (env = {}, args) =>
      spawnSync(
        "sh",
        ["scripts/start.sh", ...(args ?? ["sh", "-c", 'printf "%s" "$*" > started', "x", "ARG1"])],
        {
          cwd: dir,
          encoding: "utf-8",
          timeout: 60_000,
          killSignal: "SIGKILL",
          env: envFor({
            PATH: process.env.PATH,
            PRISMA_BIN: path.join(dir, "bin", "prisma"),
            SQLITE3_BIN: path.join(dir, "bin", "sqlite3"),
            DATABASE_URL: `file:${db}`,
            STUB_LOG: log,
            STUB_DB: db,
            STUB_SQLITE3: SQLITE3,
            ...env,
          }),
        },
      ),
    calls: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : []),
    copies: () =>
      readdirSync(path.dirname(db))
        .filter((f) => f.startsWith("project-forge.db.pre-migrate-"))
        .map((f) => path.join(path.dirname(db), f)),
  };
}

/** A legacy database: user tables, no _prisma_migrations. */
function seedLegacy(w: Work, file = w.db) {
  w.sql(file, 'CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT); INSERT INTO "User" VALUES (\'u1\', \'a@b.c\');');
}

/** A database with migration history (the baseline applied). */
function seedHistory(w: Work, file = w.db) {
  w.sql(
    file,
    `${MIGRATIONS_DDL} INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, started_at, applied_steps_count) VALUES ('m1', 'x', '${BASELINE}', 1, 1, 1); CREATE TABLE "User" ("id" TEXT PRIMARY KEY); INSERT INTO "User" VALUES ('u1');`,
  );
}

let rowIds = 0;
/** Adds a history row. `startedAt` is what prisma stores: milliseconds since the epoch. */
function addMigrationRow(
  w: Work,
  name: string,
  startedAt: number | string,
  state: { finished?: boolean; rolledBack?: boolean } = {},
  file = w.db,
) {
  const started = typeof startedAt === "number" ? String(startedAt) : `'${startedAt}'`;
  rowIds += 1;
  w.sql(
    file,
    `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, rolled_back_at, started_at, applied_steps_count) VALUES ('row${rowIds}', 'x', '${name.replace(/'/g, "''")}', ${state.finished ? started : "NULL"}, ${state.rolledBack ? started : "NULL"}, ${started}, 0);`,
  );
}

/** A copy of the current database under a pre-migrate name with the given stamp. */
function addCopy(w: Work, stamp: string): string {
  const target = `${w.db}.pre-migrate-${stamp}`;
  copyFileSync(w.db, target);
  return target;
}

/** A fake `date` first on PATH that prints the given text. */
function fakeClock(w: Work, output: string): Env {
  writeFileSync(path.join(w.dir, "bin", "date"), `#!/bin/sh\necho '${output}'\n`);
  chmodSync(path.join(w.dir, "bin", "date"), 0o755);
  return { PATH: `${path.join(w.dir, "bin")}:${process.env.PATH}` };
}

const verbs = (calls: string[]) => calls.map((c) => c.split(" ").slice(0, 2).join(" "));
const started = (w: Work) => existsSync(w.marker);
/** A migration the scratch image ships in addition to the baseline. */
const NEXT = "20261028000000_add_nick";

describe("scripts/start.sh baseline constant", () => {
  it("names the first and only committed migration, with a sqlite lock file", () => {
    expect(BASELINE).toMatch(/^\d{14}_baseline$/);
    const migrations = readdirSync(path.join(ROOT, "prisma", "migrations")).filter((f) =>
      statSync(path.join(ROOT, "prisma", "migrations", f)).isDirectory(),
    );
    expect(migrations[0]).toBe(BASELINE);
    expect(existsSync(path.join(ROOT, "prisma", "migrations", BASELINE, "migration.sql"))).toBe(true);
    expect(readFileSync(path.join(ROOT, "prisma", "migrations", "migration_lock.toml"), "utf-8")).toMatch(
      /^provider = "sqlite"$/m,
    );
  });

  it("is invoked by the image CMD, which no longer pushes the schema", () => {
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");
    const code = dockerfile
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).toMatch(/^CMD \["sh", "scripts\/start\.sh", "node_modules\/\.bin\/next", "start"\]$/m);
    expect(code).toContain("COPY scripts/start.sh ./scripts/start.sh");
    expect(code).not.toMatch(/db push/);
  });
});

describe("scripts/start.sh with a stub prisma", () => {
  it("missing database file: migrate deploy only, no check, no copy, then the server", () => {
    const w = newWork();
    const r = w.run();
    expect(r.status).toBe(0);
    expect(verbs(w.calls())).toEqual(["prisma migrate"]);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=0]"]);
    expect(w.copies()).toEqual([]);
    expect(readFileSync(w.marker, "utf-8")).toBe("ARG1");
  });

  it("existing file without any table (empty): migrate deploy only, no copy", () => {
    const w = newWork();
    writeFileSync(w.db, "");
    const r = w.run();
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=0]"]);
    expect(w.copies()).toEqual([]);
    expect(started(w)).toBe(true);
  });

  it("empty SQLite database that only had its tables dropped: still plain deploy", () => {
    const w = newWork();
    w.sql(w.db, 'CREATE TABLE t (a); DROP TABLE t;');
    const r = w.run();
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=0]"]);
    expect(w.copies()).toEqual([]);
  });

  it("history present and every shipped migration applied: deploy only, no copy", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run();
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=0]"]);
    expect(r.stdout).toContain("no copy needed");
    expect(w.copies()).toEqual([]);
    expect(started(w)).toBe(true);
  });

  it("history present, a shipped migration has no row: copy exists before deploy, deploy, server", () => {
    const w = newWork();
    seedHistory(w);
    addLocalMigration(w.dir, NEXT);
    const r = w.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`migrations to apply: ${NEXT}`);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=1]"]);
    const [copy] = w.copies();
    expect(copy).toMatch(/project-forge\.db\.pre-migrate-\d{8}T\d{6}Z$/);
    expect(w.sql(copy, 'SELECT id FROM "User"')).toBe("u1");
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(started(w)).toBe(true);
  });

  it("history present, pending, copy fails: abort before deploy, server not started", () => {
    const w = newWork();
    seedHistory(w);
    addLocalMigration(w.dir, NEXT);
    const r = w.run({ STUB_BACKUP_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual([]);
    expect(w.copies()).toEqual([]);
    expect(readdirSync(path.dirname(w.db)).filter((f) => f.includes("pre-migrate"))).toEqual([]);
    expect(r.stderr).toContain("could not copy");
    expect(started(w)).toBe(false);
  });

  it("every start that finds a pending migration writes a fresh copy, also of an unchanged database", () => {
    const w = newWork();
    seedHistory(w);
    addLocalMigration(w.dir, NEXT);
    // The stub deploy applies nothing, so the migration stays pending.
    const first = w.run();
    expect(first.status).toBe(0);
    expect(w.copies()).toHaveLength(1);
    const second = w.run();
    expect(second.status).toBe(0);
    expect(w.copies()).toHaveLength(2);
    expect(second.stdout).toContain("pre-migrate copy written");
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=1]", "prisma migrate deploy [copies=2]"]);
  });

  it("two copies within the same second get distinct names instead of aborting", () => {
    const w = newWork();
    seedHistory(w);
    addLocalMigration(w.dir, NEXT);
    const env = fakeClock(w, "20260101T000000Z");
    expect(w.run(env).status).toBe(0);
    expect(w.run(env).status).toBe(0);
    // A third start in the same second must skip the -1 that exists too.
    expect(w.run(env).status).toBe(0);
    expect(w.copies().map((c) => path.basename(c)).sort()).toEqual([
      "project-forge.db.pre-migrate-20260101T000000Z",
      "project-forge.db.pre-migrate-20260101T000000Z-1",
      "project-forge.db.pre-migrate-20260101T000000Z-2",
    ]);
  });

  it("a clock answer the copy-name parser would not accept: abort before deploy, no copy", () => {
    const w = newWork();
    seedHistory(w);
    addLocalMigration(w.dir, NEXT);
    const r = w.run(fakeClock(w, "Tue Oct 27"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not of the form");
    expect(w.calls()).toEqual([]);
    expect(readdirSync(path.dirname(w.db)).filter((f) => f.includes("pre-migrate"))).toEqual([]);
    expect(started(w)).toBe(false);
  });

  it("legacy database equal to the schema: copy, resolve baseline, deploy, server (in that order)", () => {
    const w = newWork();
    seedLegacy(w);
    const r = w.run({ STUB_DIFF_RC: "0" });
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual([
      `prisma migrate diff --from-url file:${w.db} --to-schema-datamodel prisma/schema.prisma --exit-code [copies=0]`,
      `prisma migrate resolve --applied ${BASELINE} [copies=1]`,
      "prisma migrate deploy [copies=1]",
    ]);
    expect(w.sql(w.copies()[0], 'SELECT email FROM "User"')).toBe("a@b.c");
    expect(started(w)).toBe(true);
  });

  it("legacy database that differs from the schema: abort, nothing resolved, deployed, copied or pushed", () => {
    const w = newWork();
    seedLegacy(w);
    const r = w.run({ STUB_DIFF_RC: "2" });
    expect(r.status).not.toBe(0);
    expect(verbs(w.calls())).toEqual(["prisma migrate"]);
    expect(w.calls()).toHaveLength(1);
    expect(w.calls()[0]).toContain("migrate diff");
    expect(w.copies()).toEqual([]);
    expect(r.stderr).toContain("differs from prisma/schema.prisma");
    expect(r.stderr).toContain("NOT baselined");
    expect(r.stderr).toContain("Database migrations");
    expect(started(w)).toBe(false);
  });

  it("legacy database, the comparison itself errors: abort without resolve or deploy", () => {
    const w = newWork();
    seedLegacy(w);
    const r = w.run({ STUB_DIFF_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toHaveLength(1);
    expect(w.copies()).toEqual([]);
    expect(r.stderr).toContain("could not compare");
    expect(started(w)).toBe(false);
  });

  it("legacy database equal to the schema but the copy fails: no resolve, no deploy", () => {
    const w = newWork();
    seedLegacy(w);
    const r = w.run({ STUB_DIFF_RC: "0", STUB_BACKUP_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toHaveLength(1);
    expect(w.calls()[0]).toContain("migrate diff");
    expect(started(w)).toBe(false);
  });

  it("legacy database, resolve fails: no deploy, copy kept and named", () => {
    const w = newWork();
    seedLegacy(w);
    const r = w.run({ STUB_DIFF_RC: "0", STUB_RESOLVE_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(verbs(w.calls())).toEqual(["prisma migrate", "prisma migrate"]);
    expect(w.calls().some((c) => c.includes("migrate deploy"))).toBe(false);
    expect(w.copies()).toHaveLength(1);
    expect(r.stderr).toContain(w.copies()[0]);
    expect(started(w)).toBe(false);
  });

  it("deploy fails on a missing database: non-zero, server not started, says there is no copy and to delete the new file", () => {
    const w = newWork();
    const r = w.run({ STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=0]"]);
    expect(r.stderr).toContain("prisma migrate deploy failed");
    expect(r.stderr).toContain(`${w.db} did not exist before this start, so no copy was taken`);
    expect(r.stderr).toContain(`delete ${w.db}, ${w.db}-journal`);
    expect(started(w)).toBe(false);
  });

  it("deploy fails on a database without tables: says it had no tables and there is no copy", () => {
    const w = newWork();
    writeFileSync(w.db, "");
    const r = w.run({ STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${w.db} had no tables before this start, so no copy was taken`);
    expect(w.copies()).toEqual([]);
  });

  it("deploy fails with nothing pending: says no copy was taken because nothing was pending", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run({ STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No copy was taken: no migration was pending.");
    expect(w.copies()).toEqual([]);
    expect(started(w)).toBe(false);
  });

  it("deploy fails after a pre-migrate copy: non-zero, message names the copy", () => {
    const w = newWork();
    seedHistory(w);
    addLocalMigration(w.dir, NEXT);
    const r = w.run({ STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(w.copies()).toHaveLength(1);
    expect(r.stderr).toContain(`pre-migrate copy: ${w.copies()[0]}`);
    expect(started(w)).toBe(false);
  });

  it("deploy fails after a legacy baseline: non-zero, server not started", () => {
    const w = newWork();
    seedLegacy(w);
    const r = w.run({ STUB_DIFF_RC: "0", STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(started(w)).toBe(false);
  });

  it("a file that is not a database aborts before any prisma call", () => {
    const w = newWork();
    writeFileSync(w.db, "this is not a sqlite database, ".repeat(10));
    const r = w.run();
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual([]);
    expect(r.stderr).toContain("cannot read the SQLite database");
    expect(started(w)).toBe(false);
  });

  it("a directory at the database path aborts", () => {
    const w = newWork();
    mkdirSync(w.db);
    const r = w.run();
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual([]);
    expect(started(w)).toBe(false);
  });

  it("never invokes prisma db push, on any path", () => {
    const states: Array<[string, (w: Work) => void, Env]> = [
      ["missing", () => undefined, {}],
      ["history", (w) => seedHistory(w), {}],
      ["history, pending", (w) => (seedHistory(w), addLocalMigration(w.dir, NEXT)), {}],
      ["legacy", (w) => seedLegacy(w), { STUB_DIFF_RC: "0" }],
      ["drift", (w) => seedLegacy(w), { STUB_DIFF_RC: "2" }],
    ];
    for (const [, seed, env] of states) {
      const w = newWork();
      seed(w);
      w.run(env);
      expect(w.calls().filter((c) => !c.startsWith("prisma migrate "))).toEqual([]);
    }
    // The only prisma invocations in the script are `migrate ...` ones.
    const invocations = SCRIPT_TEXT.match(/"\$PRISMA" +\w+( +\w+)?/g) ?? [];
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.filter((i) => !/ migrate( |$)/.test(i))).toEqual([]);
  });

  describe("DATABASE_URL", () => {
    it("unset: abort", () => {
      const w = newWork();
      const r = w.run({ DATABASE_URL: "" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("DATABASE_URL is not set");
      expect(w.calls()).toEqual([]);
      expect(started(w)).toBe(false);
    });

    it("not a file: URL: abort", () => {
      const w = newWork();
      const r = w.run({ DATABASE_URL: "postgresql://u:p@h/db" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("must be a SQLite file: URL");
      expect(w.calls()).toEqual([]);
    });

    it("a relative path resolves against prisma/, like Prisma does", () => {
      const w = newWork();
      const rel = path.join(w.dir, "prisma", "db", "rel.db");
      mkdirSync(path.dirname(rel));
      seedHistory(w, rel);
      addLocalMigration(w.dir, NEXT);
      const r = w.run({ DATABASE_URL: "file:./db/rel.db", STUB_DB: rel });
      expect(r.status).toBe(0);
      expect(readdirSync(path.dirname(rel)).filter((f) => f.startsWith("rel.db.pre-migrate-"))).toHaveLength(1);
      expect(started(w)).toBe(true);
    });

    it("a query string is not part of the file path", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      const r = w.run({ DATABASE_URL: `file:${w.db}?connection_limit=1` });
      expect(r.status).toBe(0);
      expect(w.copies()).toHaveLength(1);
    });

    it("a path with a single quote is refused (it would break the .backup command)", () => {
      const w = newWork();
      const r = w.run({ DATABASE_URL: `file:${w.dir}/it's.db` });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("single quote");
      expect(w.calls()).toEqual([]);
    });
  });

  it("without a server command it refuses to run", () => {
    const w = newWork();
    const r = w.run({}, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("usage");
    expect(w.calls()).toEqual([]);
  });

  it("a missing sqlite3 aborts with its own message before any other step, in every database state", () => {
    const seeds: Array<[string, (w: Work) => void]> = [
      ["no database file", () => undefined],
      ["history, migration pending", (w) => (seedHistory(w), addLocalMigration(w.dir, NEXT))],
      ["legacy tables", (w) => seedLegacy(w)],
    ];
    for (const [state, seed] of seeds) {
      const w = newWork();
      seed(w);
      const r = w.run({ SQLITE3_BIN: path.join(w.dir, "bin", "no-such-sqlite3") });
      expect(r.status, state).not.toBe(0);
      expect(r.stderr, state).toContain("sqlite3 not found");
      expect(r.stderr, state).toContain("no-such-sqlite3");
      expect(r.stderr, state).not.toContain("cannot read the SQLite database");
      expect(w.calls(), state).toEqual([]);
      expect(w.copies(), state).toEqual([]);
      expect(started(w), state).toBe(false);
    }
  });

  describe("the pending set comes from _prisma_migrations and prisma/migrations, not from migrate status", () => {
    type Row = [name: string, state: { finished?: boolean; rolledBack?: boolean }];
    const OTHER = "20261099000000_newer_release";
    const cases: Array<{ state: string; local: string[]; rows: Row[]; pending: string[] }> = [
      {
        state: "marked rolled back only (the shape `resolve --rolled-back` leaves)",
        local: [NEXT],
        rows: [[NEXT, { rolledBack: true }]],
        pending: [NEXT],
      },
      {
        state: "finished, then marked rolled back",
        local: [NEXT],
        rows: [[NEXT, { finished: true, rolledBack: true }]],
        pending: [NEXT],
      },
      {
        state: "a shipped migration older than the newest applied one",
        local: ["20261027500000_early", NEXT],
        rows: [[NEXT, { finished: true }]],
        pending: ["20261027500000_early"],
      },
      {
        state: "marked rolled back, plus a later applied row the image does not ship",
        local: [NEXT],
        rows: [
          [NEXT, { rolledBack: true }],
          [OTHER, { finished: true }],
        ],
        pending: [NEXT],
      },
      { state: "fully applied history", local: [NEXT], rows: [[NEXT, { finished: true }]], pending: [] },
      {
        state: "an applied row the image does not ship (a previous release on a newer database)",
        local: [],
        rows: [[OTHER, { finished: true }]],
        pending: [],
      },
      {
        state: "a rolled-back row the image does not ship",
        local: [],
        rows: [[OTHER, { rolledBack: true }]],
        pending: [],
      },
      {
        state: "marked rolled back once, applied again later (two rows)",
        local: [NEXT],
        rows: [
          [NEXT, { rolledBack: true }],
          [NEXT, { finished: true }],
        ],
        pending: [],
      },
    ];

    for (const c of cases) {
      for (const status of ["0", "1"]) {
        it(`${c.state}, migrate status stubbed to ${status}: ${c.pending.length ? "copy, then deploy" : "deploy, no copy"}`, () => {
          const w = newWork();
          seedHistory(w);
          for (const name of c.local) addLocalMigration(w.dir, name);
          c.rows.forEach(([name, state], i) => addMigrationRow(w, name, 1_000 + i, state));
          const r = w.run({ STUB_STATUS_RC: status });
          expect(r.status, r.stderr).toBe(0);
          expect(w.calls()).toEqual([`prisma migrate deploy [copies=${c.pending.length ? 1 : 0}]`]);
          expect(w.copies()).toHaveLength(c.pending.length ? 1 : 0);
          if (c.pending.length) expect(r.stdout).toContain(`migrations to apply: ${c.pending.join(" ")}\n`);
          else expect(r.stdout).toContain("no copy needed");
          expect(started(w)).toBe(true);
        });
      }
    }

    it("a migration name with a single quote is matched exactly", () => {
      const w = newWork();
      seedHistory(w);
      const odd = "20261028000000_it's";
      addLocalMigration(w.dir, odd);
      expect(w.run().status).toBe(0);
      expect(w.copies()).toHaveLength(1);
      addMigrationRow(w, odd, 2_000, { finished: true });
      expect(w.run().status).toBe(0);
      expect(w.copies()).toHaveLength(1);
    });

    it("the script never runs `prisma migrate status`", () => {
      expect(SCRIPT_TEXT).not.toMatch(/"\$PRISMA" +migrate +status/);
    });
  });

  describe("prisma/migrations holds an entry that prisma and this script read differently", () => {
    // prisma 5.22 lists every directory entry (dot-directories too), leaves out
    // symlinks and fails on a directory without migration.sql (P3015).
    const stops: Array<[string, (w: Work) => void]> = [
      ["a directory without migration.sql", (w) => mkdirSync(path.join(w.dir, "prisma", "migrations", "20261029000000_no_sql"))],
      ["an empty dot-directory", (w) => mkdirSync(path.join(w.dir, "prisma", "migrations", ".hidden"))],
      ["a dot-directory that has a migration.sql", (w) => addLocalMigration(w.dir, ".20261029000000_dot")],
      ["a directory named with two leading dots", (w) => addLocalMigration(w.dir, "..20261029000000_dots")],
      [
        "a symlink to a valid migration directory",
        (w) => symlinkSync(path.join(w.dir, "prisma", "migrations", BASELINE), path.join(w.dir, "prisma", "migrations", "20261029000000_link")),
      ],
      [
        "a dangling symlink",
        (w) => symlinkSync(path.join(w.dir, "nowhere"), path.join(w.dir, "prisma", "migrations", "20261029000000_dangling")),
      ],
    ];
    for (const [what, make] of stops) {
      it(`${what}: stop, no copy, no prisma call, database unchanged`, () => {
        const w = newWork();
        seedHistory(w);
        addLocalMigration(w.dir, NEXT);
        make(w);
        const before = readFileSync(w.db);
        const r = w.run();
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("Nothing was changed");
        expect(r.stderr).toContain("Database migrations");
        expect(w.calls()).toEqual([]);
        expect(w.copies()).toEqual([]);
        expect(Buffer.compare(readFileSync(w.db), before)).toBe(0);
        expect(started(w)).toBe(false);
      });
    }

    it("the stop also applies when nothing is pending", () => {
      const w = newWork();
      seedHistory(w);
      mkdirSync(path.join(w.dir, "prisma", "migrations", ".hidden"));
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(w.calls()).toEqual([]);
      expect(started(w)).toBe(false);
    });

    it("names the entry", () => {
      const w = newWork();
      seedHistory(w);
      mkdirSync(path.join(w.dir, "prisma", "migrations", "20261029000000_no_sql"));
      expect(w.run().stderr).toContain("prisma/migrations/20261029000000_no_sql has no migration.sql");
      const v = newWork();
      seedHistory(v);
      mkdirSync(path.join(v.dir, "prisma", "migrations", ".hidden"));
      expect(v.run().stderr).toContain("prisma/migrations/.hidden is a directory whose name starts with a dot");
      const x = newWork();
      seedHistory(x);
      symlinkSync(path.join(x.dir, "nowhere"), path.join(x.dir, "prisma", "migrations", "ln"));
      expect(x.run().stderr).toContain("prisma/migrations/ln is a symlink");
    });

    it("regular files are ignored (the lock file, a readme, a dot file), also a pending migration next to them", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      writeFileSync(path.join(w.dir, "prisma", "migrations", "migration_lock.toml"), 'provider = "sqlite"\n');
      writeFileSync(path.join(w.dir, "prisma", "migrations", "README.md"), "notes\n");
      writeFileSync(path.join(w.dir, "prisma", "migrations", ".DS_Store"), "x");
      const r = w.run();
      expect(r.status, r.stderr).toBe(0);
      expect(w.calls()).toEqual(["prisma migrate deploy [copies=1]"]);
      expect(started(w)).toBe(true);
    });

    it("a failed migration row is reported before the directory problem", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, NEXT, Date.UTC(2026, 2, 10, 12, 0, 0, 500));
      mkdirSync(path.join(w.dir, "prisma", "migrations", ".hidden"));
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`migration ${NEXT} failed halfway`);
      expect(r.stderr).not.toContain("starts with a dot");
    });
  });

  describe("a deploy that fails before prisma records a row does not add a copy on every restart", () => {
    const OTHER = "20261099000000_newer_release";
    // The newest applied migration finished at 20260310T120000Z (500 ms into the second).
    const FINISHED = Date.UTC(2026, 2, 10, 12, 0, 0, 500);
    const setup = (finished: number | string = FINISHED) => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      addLocalMigration(w.dir, OTHER);
      addMigrationRow(w, OTHER, finished, { finished: true });
      return w;
    };
    const message = (n: number) =>
      `deploy keeps failing before it records a migration (${n} copies since the last applied migration); nothing was changed.`;

    it("deploy fails without a row, five restarts: three copies, the fourth and fifth start stop without a copy or a prisma call", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      for (let n = 1; n <= 3; n++) {
        const r = w.run({ STUB_DEPLOY_RC: "1" });
        expect(r.status, `start ${n}`).not.toBe(0);
        expect(r.stderr, `start ${n}`).toContain("prisma migrate deploy failed");
        expect(w.copies(), `start ${n}`).toHaveLength(n);
      }
      const dbBefore = readFileSync(w.db);
      const copiesBefore = w.copies().sort();
      const callsBefore = w.calls();
      expect(callsBefore).toHaveLength(3);
      for (const n of [4, 5]) {
        const r = w.run({ STUB_DEPLOY_RC: "1" });
        expect(r.status, `start ${n}`).not.toBe(0);
        expect(r.stderr, `start ${n}`).toContain(message(3));
        expect(r.stderr, `start ${n}`).toContain("Database migrations");
        expect(r.stdout, `start ${n}`).not.toContain("pre-migrate copy written");
        expect(w.copies().sort(), `start ${n}`).toEqual(copiesBefore);
        expect(w.calls(), `start ${n}`).toEqual(callsBefore);
        expect(Buffer.compare(readFileSync(w.db), dbBefore), `start ${n}`).toBe(0);
        expect(started(w), `start ${n}`).toBe(false);
      }
    });

    it("the stop names how to clear it: fix the cause, remove the surplus copies", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      for (let n = 1; n <= 3; n++) w.run({ STUB_DEPLOY_RC: "1" });
      const r = w.run({ STUB_DEPLOY_RC: "1" });
      expect(r.stderr).toContain("remove all but one of the copies stamped after the newest applied migration");
      // Removing copies clears the stop: two left, the next start copies again.
      const [oldest, ...surplus] = w.copies().sort();
      expect(oldest).toBeDefined();
      rmSync(surplus[0]);
      const again = w.run();
      expect(again.status, again.stderr).toBe(0);
      expect(w.copies()).toHaveLength(3);
    });

    it("a later applied migration (newer than the copies) resets the count", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      for (let n = 1; n <= 3; n++) w.run({ STUB_DEPLOY_RC: "1" });
      expect(w.run({ STUB_DEPLOY_RC: "1" }).stderr).toContain(message(3));
      // A migration applies (a later release, a repaired deploy): its finished_at is after the copies.
      addLocalMigration(w.dir, OTHER);
      addMigrationRow(w, OTHER, Date.now() + 5_000, { finished: true });
      const r = w.run({ STUB_DEPLOY_RC: "1" });
      expect(r.stderr).not.toContain("keeps failing");
      expect(r.stdout).toContain("pre-migrate copy written");
      expect(w.copies()).toHaveLength(4);
    });

    // Copies are given explicit stamps so that the cases do not depend on the clock.
    const cases: Array<{ what: string; finished?: number | string; stamps: string[]; stops: number | null }> = [
      { what: "two copies newer than the newest applied migration", stamps: ["20260310T120001Z", "20260310T120002Z"], stops: null },
      { what: "three copies newer than it", stamps: ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z"], stops: 3 },
      { what: "four copies newer than it (the message counts them)", stamps: ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z", "20260310T120004Z"], stops: 4 },
      {
        what: "three copies of which one is in the second the migration finished (not newer)",
        stamps: ["20260310T120000Z", "20260310T120001Z", "20260310T120002Z"],
        stops: null,
      },
      {
        what: "three copies of which one is older than it",
        stamps: ["20260310T115959Z", "20260310T120001Z", "20260310T120002Z"],
        stops: null,
      },
      { what: "three copies, all older than it", stamps: ["20260310T115957Z", "20260310T115958Z", "20260310T115959Z"], stops: null },
      {
        what: "a second copy in the same second (-1) counts like any other",
        stamps: ["20260310T120001Z", "20260310T120001Z-1", "20260310T120001Z-2"],
        stops: 3,
      },
      {
        what: "two stamped copies and an unstamped one next to them",
        stamps: ["20260310T120001Z", "20260310T120002Z", "manual"],
        stops: null,
      },
      {
        what: "an applied migration with a text finished_at (the column's text form)",
        finished: "2026-03-10 12:00:00",
        stamps: ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z"],
        stops: 3,
      },
      {
        what: "an applied migration with a text finished_at, copies older than it",
        finished: "2026-03-10 12:00:10",
        stamps: ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z"],
        stops: null,
      },
    ];
    for (const c of cases) {
      it(`${c.what}: ${c.stops ? "stop, no copy, no prisma call" : "copy, deploy, server"}`, () => {
        const w = setup(c.finished ?? FINISHED);
        for (const stamp of c.stamps) addCopy(w, stamp);
        const before = readFileSync(w.db);
        const r = w.run();
        if (c.stops) {
          expect(r.status).not.toBe(0);
          expect(r.stderr).toContain(message(c.stops));
          expect(w.copies()).toHaveLength(c.stamps.length);
          expect(w.calls()).toEqual([]);
          expect(Buffer.compare(readFileSync(w.db), before)).toBe(0);
          expect(started(w)).toBe(false);
        } else {
          expect(r.status, r.stderr).toBe(0);
          expect(w.copies()).toHaveLength(c.stamps.length + 1);
          expect(w.calls()).toEqual([`prisma migrate deploy [copies=${c.stamps.length + 1}]`]);
          expect(started(w)).toBe(true);
        }
      });
    }

    it("the newest applied migration decides, not an older one", () => {
      const w = setup();
      // An older applied row (seedHistory's baseline, 1970) and a newer one (FINISHED): three copies between them.
      for (const stamp of ["20260101T000001Z", "20260101T000002Z", "20260101T000003Z"]) addCopy(w, stamp);
      const r = w.run();
      expect(r.status, r.stderr).toBe(0);
      expect(w.copies()).toHaveLength(4);
    });

    it("a migration marked rolled back is not an applied one: it does not reset the count", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, NEXT);
      // finished_at set but rolled back, far in the future: not applied.
      addMigrationRow(w, NEXT, Date.UTC(2099, 0, 1), { finished: true, rolledBack: true });
      for (const stamp of ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z"]) addCopy(w, stamp);
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(message(3));
      expect(w.copies()).toHaveLength(3);
    });

    it("no applied row at all: every stamped copy counts", () => {
      // The history table exists but holds nothing applied (the only row is rolled back).
      const stage = (copies: number) => {
        const w = newWork();
        w.sql(w.db, `${MIGRATIONS_DDL} CREATE TABLE "User" ("id" TEXT PRIMARY KEY);`);
        addLocalMigration(w.dir, NEXT);
        addMigrationRow(w, NEXT, 1_000, { rolledBack: true });
        for (const stamp of ["19990101T000000Z", "20150101T000000Z", "20260101T000000Z"].slice(0, copies)) addCopy(w, stamp);
        return w;
      };
      const two = stage(2);
      expect(two.run().status).toBe(0);
      expect(two.copies()).toHaveLength(3);
      const three = stage(3);
      const r = three.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(message(3));
      expect(three.calls()).toEqual([]);
    });

    it("nothing pending: a start with many old copies still runs the (no-op) deploy and starts", () => {
      const w = newWork();
      seedHistory(w);
      for (const stamp of ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z", "20260310T120004Z"]) addCopy(w, stamp);
      const r = w.run();
      expect(r.status, r.stderr).toBe(0);
      expect(w.calls()).toEqual(["prisma migrate deploy [copies=4]"]);
      expect(started(w)).toBe(true);
    });

    it("the baseline of a db-push database copies once while fewer than three stamped copies exist", () => {
      const w = newWork();
      seedLegacy(w);
      for (const stamp of ["20260310T120001Z", "20260310T120002Z"]) addCopy(w, stamp);
      const r = w.run({ STUB_DIFF_RC: "0" });
      expect(r.status, r.stderr).toBe(0);
      expect(w.copies()).toHaveLength(3);
      expect(started(w)).toBe(true);
    });

    it("a baseline whose resolve keeps failing stops after three copies, without a copy or a resolve", () => {
      const w = newWork();
      seedLegacy(w);
      for (let i = 0; i < 5; i++) {
        const r = w.run({ STUB_DIFF_RC: "0", STUB_RESOLVE_RC: "1" });
        expect(r.status).not.toBe(0);
        if (i >= 3) {
          expect(r.stderr).toContain("deploy keeps failing before it records a migration (3 copies, no migration applied yet)");
          expect(r.stderr).toContain("move them to a name outside the");
        }
      }
      expect(w.copies()).toHaveLength(3);
      expect(started(w)).toBe(false);
    });

    it("a failed migration row is reported before the copy bound", () => {
      const w = setup();
      addMigrationRow(w, NEXT, Date.UTC(2026, 2, 10, 12, 0, 5, 0));
      for (const stamp of ["20260310T120001Z", "20260310T120002Z", "20260310T120003Z"]) addCopy(w, stamp);
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`migration ${NEXT} failed halfway`);
      expect(r.stderr).not.toContain("keeps failing");
    });
  });

  describe("a migration recorded as failed (finished_at and rolled_back_at empty)", () => {
    // prisma stores started_at as milliseconds since the epoch.
    const STARTED = Date.UTC(2026, 2, 10, 12, 0, 0, 500); // 20260310T120000Z
    const BAD = "20261028000000_bad";

    it("restart loop: the first start copies once, later starts stop at the failed row and keep naming that copy", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, BAD);
      const first = w.run({ STUB_DEPLOY_RC: "1", STUB_DEPLOY_FAIL_ROW: BAD });
      expect(first.status).not.toBe(0);
      expect(w.copies()).toHaveLength(1);
      const [c1] = w.copies();
      expect(first.stderr).toContain(c1);
      const callsAfterFirst = w.calls();
      expect(callsAfterFirst).toEqual(["prisma migrate deploy [copies=1]"]);

      for (let start = 2; start <= 3; start++) {
        const again = w.run();
        expect(again.status, `start ${start}`).not.toBe(0);
        // No new copy (a copy of the damaged file would look like a restore point),
        // no prisma call at all, no server.
        expect(w.copies(), `start ${start}`).toEqual([c1]);
        expect(w.calls(), `start ${start}`).toEqual(callsAfterFirst);
        expect(started(w), `start ${start}`).toBe(false);
        expect(again.stderr, `start ${start}`).toContain(BAD);
        expect(again.stderr, `start ${start}`).toContain(`restore ${c1} `);
        expect(again.stderr, `start ${start}`).toContain("never rolled back");
        expect(again.stderr, `start ${start}`).toContain("migrate deploy was not run");
        expect(again.stderr, `start ${start}`).not.toContain("Warning");
      }
    });

    it("the failed row wins over a pending migration: nothing is called, nothing copied", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, BAD);
      addLocalMigration(w.dir, "20261029000000_later");
      addMigrationRow(w, BAD, STARTED);
      const r = w.run({ STUB_STATUS_RC: "0" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(BAD);
      expect(w.calls()).toEqual([]);
      expect(w.copies()).toEqual([]);
      expect(started(w)).toBe(false);
    });

    it("the failed row also stops a start with nothing pending", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(BAD);
      expect(w.calls()).toEqual([]);
      expect(started(w)).toBe(false);
    });

    it("names the start time and the newest copy older than it; a newer copy is ignored", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      const oldest = addCopy(w, "20260301T000000Z");
      const wanted = addCopy(w, "20260310T110000Z");
      const newer = addCopy(w, "20260310T130000Z");
      const newest = addCopy(w, "20260311T000000Z");
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(BAD);
      expect(r.stderr).toContain("since 20260310T120000Z, UTC");
      expect(r.stderr).toContain(`restore ${wanted} `);
      for (const other of [oldest, newer, newest]) expect(r.stderr).not.toContain(other);
      expect(r.stderr).toContain(`${w.db}-journal`);
      expect(w.copies().sort()).toEqual([oldest, wanted, newer, newest].sort());
      expect(w.calls()).toEqual([]);
    });

    it("a copy made in the same second as the start counts; of two in that second the later name wins", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      addCopy(w, "20260310T110000Z");
      addCopy(w, "20260310T120000Z");
      const wanted = addCopy(w, "20260310T120000Z-1");
      addCopy(w, "20260310T120001Z");
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`restore ${wanted} `);
    });

    it("suffixes compare as numbers: -10 is newer than -2", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      addCopy(w, "20260310T110000Z-2");
      const wanted = addCopy(w, "20260310T110000Z-10");
      addCopy(w, "20260310T110000Z");
      const r = w.run();
      expect(r.stderr).toContain(`restore ${wanted} `);
    });

    it("names under the prefix that are not exactly stamped are never chosen", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      const wanted = addCopy(w, "20260310T110000Z");
      const decoys = [
        "manual",
        "20260310T115959Z.bak",
        "20260310T115959Z-x",
        "20260310T115959Z-1-2",
        "20260310T115959Z-",
        "20260310T115959Z-12345678901",
        "20260310T115959",
        "x20260310T115959Z",
      ].map((s) => addCopy(w, s));
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`restore ${wanted} `);
      for (const d of decoys) expect(r.stderr).not.toContain(d);
    });

    it("an unstamped file under the prefix identical to the database is ignored: a stamped copy is written and later named", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, BAD);
      const own = `${w.db}.pre-migrate-x`;
      copyFileSync(w.db, own);
      const first = w.run({ STUB_DEPLOY_RC: "1", STUB_DEPLOY_FAIL_ROW: BAD });
      expect(first.status).not.toBe(0);
      const stamped = w.copies().filter((c) => c !== own);
      expect(stamped).toHaveLength(1);
      expect(stamped[0]).toMatch(/\.pre-migrate-\d{8}T\d{6}Z$/);
      expect(first.stdout).toContain(`pre-migrate copy written: ${stamped[0]}`);
      expect(first.stderr).toContain(`pre-migrate copy: ${stamped[0]}`);
      const again = w.run();
      expect(again.stderr).toContain(`restore ${stamped[0]} `);
      expect(again.stderr).not.toContain(own);
    });

    it("no copy older than the start: says so, names no newer copy, takes none", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      const newer = addCopy(w, "20260310T120001Z");
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no pre-migrate copy older than that start");
      expect(r.stderr).not.toContain(newer);
      expect(r.stderr).not.toContain("restore " + w.db + ".pre-migrate");
      expect(w.copies()).toEqual([newer]);
      expect(w.calls()).toEqual([]);
    });

    it("no copy at all: says so, and what to do for a database that start created", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, STARTED);
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no pre-migrate copy older than that start");
      expect(r.stderr).toContain(`If the start that ran the failed migration created ${w.db}`);
      expect(r.stderr).toContain("Otherwise restore your own backup of the database.");
      expect(w.copies()).toEqual([]);
    });

    it("a new database whose migration fails: the deploy error and every restart say to delete it", () => {
      const w = newWork();
      addLocalMigration(w.dir, BAD);
      const first = w.run({ STUB_DEPLOY_RC: "1", STUB_DEPLOY_FAIL_ROW: BAD });
      expect(first.status).not.toBe(0);
      expect(first.stderr).toContain(`${w.db} did not exist before this start, so no copy was taken`);
      expect(first.stderr).toContain(`delete ${w.db}`);
      for (let start = 2; start <= 3; start++) {
        const again = w.run();
        expect(again.status, `start ${start}`).not.toBe(0);
        expect(again.stderr, `start ${start}`).toContain(BAD);
        expect(again.stderr, `start ${start}`).toContain(
          `If the start that ran the failed migration created ${w.db} (no database file or no table before it, so it took no copy), stop the container, delete ${w.db}, ${w.db}-journal, ${w.db}-wal and ${w.db}-shm and fix the migration.`,
        );
        expect(w.copies(), `start ${start}`).toEqual([]);
        expect(w.calls(), `start ${start}`).toEqual(["prisma migrate deploy [copies=0]"]);
      }
    });

    it("another row started after the chosen copy: the message warns that the copy may predate later changes", () => {
      const w = newWork();
      seedHistory(w);
      const copy = addCopy(w, "20260310T110000Z");
      addMigrationRow(w, "20261027500000_by_hand", STARTED - 30 * 60_000, { finished: true });
      addMigrationRow(w, BAD, STARTED);
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`restore ${copy} `);
      expect(r.stderr).toContain(
        "Warning: _prisma_migrations also has rows that started after that copy was taken (20261027500000_by_hand), so the copy may predate later changes.",
      );
      expect(r.stderr).not.toContain(`(${BAD}`);
      expect(r.stderr).not.toContain(BASELINE);
    });

    it("a row in the copy's own second counts as later; rows before it do not", () => {
      const w = newWork();
      seedHistory(w);
      addCopy(w, "20260310T110000Z");
      addMigrationRow(w, "20261027400000_before", Date.UTC(2026, 2, 10, 10, 59, 59, 999), { finished: true });
      addMigrationRow(w, "20261027500000_same_second", Date.UTC(2026, 2, 10, 11, 0, 0, 0), { finished: true });
      addMigrationRow(w, BAD, STARTED);
      const r = w.run();
      expect(r.stderr).toContain("(20261027500000_same_second), so the copy may predate later changes");
    });

    it("a row whose start time cannot be read counts as later", () => {
      const w = newWork();
      seedHistory(w);
      addCopy(w, "20260310T110000Z");
      addMigrationRow(w, "20261027500000_odd_time", "not a time", { finished: true });
      addMigrationRow(w, BAD, STARTED);
      const r = w.run();
      expect(r.stderr).toContain("(20261027500000_odd_time), so the copy may predate later changes");
    });

    it("with several failed rows it names the oldest, and the later failed row is listed in the warning", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, "20261030000000_second", STARTED + 3_600_000);
      addMigrationRow(w, BAD, STARTED);
      const wanted = addCopy(w, "20260310T110000Z");
      addCopy(w, "20260310T125900Z");
      const r = w.run();
      expect(r.stderr).toContain(`migration ${BAD} failed halfway`);
      expect(r.stderr).toContain(`restore ${wanted} `);
      expect(r.stderr).toContain("(20261030000000_second), so the copy may predate later changes");
    });

    it("a start time stored as text is read too", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, "2026-03-10 12:00:00");
      const wanted = addCopy(w, "20260310T110000Z");
      addCopy(w, "20260310T130000Z");
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("since 20260310T120000Z, UTC");
      expect(r.stderr).toContain(`restore ${wanted} `);
    });

    it("a start time it cannot read still stops (never treated as no failure)", () => {
      const w = newWork();
      seedHistory(w);
      addMigrationRow(w, BAD, "not a time");
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot read the start time (not a time)");
      expect(w.calls()).toEqual([]);
      expect(w.copies()).toEqual([]);
      expect(started(w)).toBe(false);
    });

    it("finished and rolled-back rows are not failures: the rolled-back migration is pending, copied and deployed", () => {
      const w = newWork();
      seedHistory(w);
      addLocalMigration(w.dir, "20261028000000_done");
      addLocalMigration(w.dir, BAD);
      addMigrationRow(w, "20261028000000_done", STARTED, { finished: true });
      addMigrationRow(w, BAD, STARTED, { rolledBack: true });
      const r = w.run({ STUB_STATUS_RC: "0" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`migrations to apply: ${BAD}\n`);
      expect(w.calls()).toEqual(["prisma migrate deploy [copies=1]"]);
      expect(started(w)).toBe(true);
    });

    it("a history table without the columns prisma writes cannot be read: abort, nothing called", () => {
      const w = newWork();
      w.sql(w.db, 'CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY);');
      addLocalMigration(w.dir, NEXT);
      const r = w.run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot read the SQLite database");
      expect(w.calls()).toEqual([]);
      expect(w.copies()).toEqual([]);
    });
  });
});

describe("scripts/start.sh with the repo's own prisma and real SQLite files", () => {
  const prismaBin = path.join(ROOT, "node_modules", ".bin", "prisma");
  const realEnv = (db: string): Env => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATABASE_URL: `file:${db}`,
  });
  const start = (db: string) =>
    spawnSync("sh", ["scripts/start.sh", "sh", "-c", `echo STARTED > "${db}.started"`], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: realEnv(db) as NodeJS.ProcessEnv,
    });
  const scratch = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pf-start-real-"));
    dirs.push(dir);
    return path.join(dir, "project-forge.db");
  };
  const sql = (db: string, s: string) => {
    const r = spawnSync(SQLITE3, [db, s], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  const siblings = (db: string, infix: string) =>
    readdirSync(path.dirname(db)).filter((f) => f.startsWith(`project-forge.db.${infix}`));

  /** A scratch /app: the repo's prisma/ directory, the start script and node_modules. */
  const scratchApp = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    dirs.push(dir);
    cpSync(path.join(ROOT, "prisma"), path.join(dir, "prisma"), { recursive: true });
    mkdirSync(path.join(dir, "scripts"));
    copyFileSync(SCRIPT, path.join(dir, "scripts", "start.sh"));
    symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
    const db = path.join(dir, "data", "project-forge.db");
    mkdirSync(path.dirname(db));
    const run = () =>
      spawnSync("sh", ["scripts/start.sh", "sh", "-c", `echo STARTED > "${db}.started"`], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 120_000,
        killSignal: "SIGKILL",
        env: realEnv(db) as NodeJS.ProcessEnv,
      });
    const prisma = (...args: string[]) =>
      spawnSync(prismaBin, args, {
        cwd: dir,
        encoding: "utf-8",
        timeout: 120_000,
        killSignal: "SIGKILL",
        env: realEnv(db) as NodeJS.ProcessEnv,
      });
    return { dir, db, run, prisma };
  };

  it("missing file: creates the schema and the migration history, then starts", () => {
    const db = scratch();
    const r = start(db);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(sql(db, "SELECT migration_name FROM _prisma_migrations")).toBe(BASELINE);
    expect(sql(db, "SELECT count(*) FROM sqlite_master WHERE name = 'ApiToken'")).toBe("1");
    expect(siblings(db, "pre-migrate-")).toEqual([]);
    expect(existsSync(`${db}.started`)).toBe(true);
    // Second start: up to date, still no copy.
    rmSync(`${db}.started`);
    const again = start(db);
    expect(again.status, again.stderr).toBe(0);
    expect(siblings(db, "pre-migrate-")).toEqual([]);
  }, 120_000);

  it("db-push database equal to the schema: copied, baselined, data kept", () => {
    const db = scratch();
    const push = spawnSync(prismaBin, ["db", "push", "--skip-generate"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: realEnv(db) as NodeJS.ProcessEnv,
    });
    expect(push.status, push.stderr).toBe(0);
    sql(db, "INSERT INTO User (id, updatedAt) VALUES ('u1', 0)");
    const r = start(db);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(sql(db, "SELECT migration_name FROM _prisma_migrations")).toBe(BASELINE);
    expect(sql(db, "SELECT id FROM User")).toBe("u1");
    const copies = siblings(db, "pre-migrate-");
    expect(copies).toHaveLength(1);
    expect(sql(path.join(path.dirname(db), copies[0]), "SELECT id FROM User")).toBe("u1");
    expect(sql(path.join(path.dirname(db), copies[0]), "SELECT count(*) FROM sqlite_master WHERE name = '_prisma_migrations'")).toBe("0");
    expect(existsSync(`${db}.started`)).toBe(true);
  }, 120_000);

  it("db-push database with drift: aborts, database untouched, no history, no copy", () => {
    const db = scratch();
    const push = spawnSync(prismaBin, ["db", "push", "--skip-generate"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: realEnv(db) as NodeJS.ProcessEnv,
    });
    expect(push.status, push.stderr).toBe(0);
    sql(db, 'ALTER TABLE "ApiToken" ADD COLUMN "extra" TEXT');
    const before = readFileSync(db);
    const r = start(db);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("NOT baselined");
    expect(Buffer.compare(readFileSync(db), before)).toBe(0);
    expect(sql(db, "SELECT count(*) FROM sqlite_master WHERE name = '_prisma_migrations'")).toBe("0");
    expect(siblings(db, "pre-migrate-")).toEqual([]);
    expect(existsSync(`${db}.started`)).toBe(false);
  }, 120_000);

  it("a migration that fails halfway: one copy on the first start, restarts stop on the failed row and name that copy", () => {
    // One more migration whose second statement fails after the first one has
    // been applied.
    const { dir, db, run } = scratchApp("pf-start-halfway-");
    expect(run().status).toBe(0);
    const bad = "20261028000000_halfway";
    addLocalMigration(dir, bad, 'ALTER TABLE "User" ADD COLUMN "nick" TEXT;\nDROP TABLE "NoSuchTable";\n');
    rmSync(`${db}.started`);

    const first = run();
    expect(first.status).not.toBe(0);
    const copies = siblings(db, "pre-migrate-");
    expect(copies).toHaveLength(1);
    const c1 = path.join(path.dirname(db), copies[0]);
    expect(first.stderr).toContain(c1);
    // The migration ran halfway: the added column is there, the history row is open.
    expect(sql(db, "SELECT count(*) FROM pragma_table_info('User') WHERE name = 'nick'")).toBe("1");
    expect(sql(db, `SELECT count(*) FROM _prisma_migrations WHERE migration_name = '${bad}' AND finished_at IS NULL AND rolled_back_at IS NULL`)).toBe("1");

    for (const n of [2, 3]) {
      const again = run();
      expect(again.status, `start ${n}`).not.toBe(0);
      expect(siblings(db, "pre-migrate-"), `start ${n}`).toEqual(copies);
      expect(again.stderr, `start ${n}`).toContain(bad);
      expect(again.stderr, `start ${n}`).toContain(`restore ${c1} `);
      expect(again.stdout, `start ${n}`).not.toContain("prisma migrate");
      expect(existsSync(`${db}.started`), `start ${n}`).toBe(false);
    }

    // The documented recovery: restore the named copy, fix the migration, start.
    for (const f of [db, `${db}-journal`, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    copyFileSync(c1, db);
    writeFileSync(path.join(dir, "prisma", "migrations", bad, "migration.sql"), 'ALTER TABLE "User" ADD COLUMN "nick" TEXT;\n');
    const fixed = run();
    expect(fixed.status, fixed.stderr + fixed.stdout).toBe(0);
    expect(sql(db, "SELECT count(*) FROM pragma_table_info('User') WHERE name = 'nick'")).toBe("1");
    expect(sql(db, `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`)).toBe("2");
    expect(existsSync(`${db}.started`)).toBe(true);
  }, 240_000);

  it("after an in-place repair with resolve --rolled-back the next start copies again, and a second failure names that new copy", () => {
    const { dir, db, run, prisma } = scratchApp("pf-start-rolledback-");
    expect(run().status).toBe(0);
    rmSync(`${db}.started`);
    sql(db, "INSERT INTO User (id, updatedAt) VALUES ('u-before', 0)");
    const bad = "20261028000000_add_nick";
    addLocalMigration(dir, bad, 'ALTER TABLE "User" ADD COLUMN "nick" TEXT;\nDROP TABLE "NoSuchTable";\n');

    const first = run();
    expect(first.status).not.toBe(0);
    const [c1] = siblings(db, "pre-migrate-").map((f) => path.join(path.dirname(db), f));
    expect(c1).toBeDefined();

    // A row in the copy's own second counts as later than the copy, so a repair
    // within the same second as the failure would add a warning. An operator
    // takes longer; wait for the next second like one.
    const failedAt = Number(sql(db, `SELECT started_at FROM _prisma_migrations WHERE migration_name = '${bad}'`));
    const nextSecond = Math.floor(failedAt / 1000) * 1000 + 1000;
    if (Date.now() < nextSecond) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, nextSecond - Date.now() + 50);

    // Repair in place: undo the half that ran, mark the migration rolled back.
    sql(db, 'ALTER TABLE "User" DROP COLUMN "nick"');
    const resolve = prisma("migrate", "resolve", "--rolled-back", bad);
    expect(resolve.status, resolve.stderr + resolve.stdout).toBe(0);
    // prisma 5.22 calls this state up to date although deploy applies the
    // migration again; the start script does not ask it.
    expect(prisma("migrate", "status").status).toBe(0);
    // Written after the repair (a previous release serving in between).
    sql(db, "INSERT INTO User (id, updatedAt) VALUES ('u-after-repair', 0)");

    const second = run();
    expect(second.status).not.toBe(0);
    expect(second.stdout).toContain(`migrations to apply: ${bad}`);
    const after = siblings(db, "pre-migrate-").map((f) => path.join(path.dirname(db), f));
    expect(after).toHaveLength(2);
    const c2 = after.find((c) => c !== c1) ?? "";
    expect(second.stdout).toContain(`pre-migrate copy written: ${c2}`);
    expect(sql(c2, "SELECT group_concat(id) FROM (SELECT id FROM User ORDER BY id)")).toBe("u-after-repair,u-before");

    const restart = run();
    expect(restart.status).not.toBe(0);
    expect(restart.stderr).toContain(`restore ${c2} `);
    expect(restart.stderr).not.toContain(c1);
    expect(restart.stderr).not.toContain("Warning");
    expect(siblings(db, "pre-migrate-")).toHaveLength(2);
    expect(existsSync(`${db}.started`)).toBe(false);
  }, 240_000);

  it("a deploy that fails without recording a row (database write-locked): three copies, then the start stops; clearing the cause and the surplus copies lets it migrate", async () => {
    const { dir, db, run } = scratchApp("pf-start-locked-");
    expect(run().status).toBe(0);
    rmSync(`${db}.started`);
    // A copy in the second the last migration finished is not newer than it; start the loop in the next second.
    const finishedAt = Number(sql(db, "SELECT max(finished_at) FROM _prisma_migrations"));
    const nextSecond = Math.floor(finishedAt / 1000) * 1000 + 1000;
    if (Date.now() < nextSecond) await new Promise((r) => setTimeout(r, nextSecond - Date.now() + 50));
    sql(db, "INSERT INTO User (id, updatedAt) VALUES ('u1', 0)");
    const next = "20261028000000_add_nick";
    addLocalMigration(dir, next, 'ALTER TABLE "User" ADD COLUMN "nick" TEXT;\n');

    // Another connection holds the write lock (readers and `.backup` still work, the migration cannot write).
    const holder = spawn(SQLITE3, [db], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      holder.stdin.write("BEGIN IMMEDIATE;\nINSERT INTO User (id, updatedAt) VALUES ('u-held', 0);\n");
      let locked = false;
      for (let i = 0; i < 100 && !locked; i++) {
        await new Promise((r) => setTimeout(r, 100));
        locked = spawnSync(SQLITE3, [db, "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK;"], { encoding: "utf-8" }).status !== 0;
      }
      expect(locked, "the second connection holds the write lock").toBe(true);

      for (const n of [1, 2, 3]) {
        const r = run();
        expect(r.status, `start ${n}`).not.toBe(0);
        expect(r.stderr + r.stdout, `start ${n}`).toMatch(/database is locked|SQLITE_BUSY|timed out/i);
        expect(siblings(db, "pre-migrate-"), `start ${n}`).toHaveLength(n);
      }
      // No row was written: this is the loop the failed-row stop cannot see.
      expect(sql(db, "SELECT count(*) FROM _prisma_migrations")).toBe("1");
      const copies = siblings(db, "pre-migrate-").sort();
      for (const n of [4, 5]) {
        const r = run();
        expect(r.status, `start ${n}`).not.toBe(0);
        expect(r.stderr, `start ${n}`).toContain("deploy keeps failing before it records a migration (3 copies since the last applied migration)");
        expect(r.stdout, `start ${n}`).not.toContain("prisma migrate deploy");
        expect(siblings(db, "pre-migrate-").sort(), `start ${n}`).toEqual(copies);
      }
    } finally {
      holder.kill("SIGKILL");
      await new Promise((r) => (holder.exitCode !== null || holder.signalCode !== null ? r(undefined) : holder.once("exit", () => r(undefined))));
    }

    // The cause is gone (lock released); remove the surplus copies, keep the oldest.
    for (const f of siblings(db, "pre-migrate-").sort().slice(1)) rmSync(path.join(path.dirname(db), f));
    for (const f of [`${db}-journal`]) rmSync(f, { force: true });
    const fixed = run();
    expect(fixed.status, fixed.stderr + fixed.stdout).toBe(0);
    expect(sql(db, "SELECT count(*) FROM pragma_table_info('User') WHERE name = 'nick'")).toBe("1");
    expect(sql(db, "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")).toBe("2");
    expect(siblings(db, "pre-migrate-")).toHaveLength(2);
    expect(existsSync(`${db}.started`)).toBe(true);
    // The applied migration resets the bound: a later pending migration copies again.
    rmSync(`${db}.started`);
    addLocalMigration(dir, "20261029000000_add_nick2", 'ALTER TABLE "User" ADD COLUMN "nick2" TEXT;\n');
    const later = run();
    expect(later.status, later.stderr + later.stdout).toBe(0);
    expect(siblings(db, "pre-migrate-")).toHaveLength(3);
  }, 300_000);
});
