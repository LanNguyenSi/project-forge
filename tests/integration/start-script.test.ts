// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

const PRISMA_STUB = `#!/bin/sh
n=0
for f in "\${STUB_DB}".pre-migrate-*; do [ -e "$f" ] && n=$((n + 1)); done
echo "prisma $* [copies=$n]" >> "$STUB_LOG"
case "$1 $2" in
  "migrate status") exit "\${STUB_STATUS_RC:-0}" ;;
  "migrate diff") echo "stub diff output"; exit "\${STUB_DIFF_RC:-0}" ;;
  "migrate resolve") exit "\${STUB_RESOLVE_RC:-0}" ;;
  "migrate deploy") exit "\${STUB_DEPLOY_RC:-0}" ;;
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

/** A scratch working directory laid out like /app: prisma/, scripts/start.sh. */
function newWork(): Work {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-start-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "prisma", "migrations", BASELINE), { recursive: true });
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

/** A database with migration history. */
function seedHistory(w: Work, file = w.db) {
  w.sql(file, 'CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY); CREATE TABLE "User" ("id" TEXT PRIMARY KEY); INSERT INTO "User" VALUES (\'u1\');');
}

const verbs = (calls: string[]) => calls.map((c) => c.split(" ").slice(0, 2).join(" "));
const started = (w: Work) => existsSync(w.marker);

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

  it("history present and up to date: status then deploy, no copy", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run({ STUB_STATUS_RC: "0" });
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual(["prisma migrate status [copies=0]", "prisma migrate deploy [copies=0]"]);
    expect(w.copies()).toEqual([]);
    expect(started(w)).toBe(true);
  });

  it("history present, migration pending: copy exists before deploy, deploy, server", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run({ STUB_STATUS_RC: "1" });
    expect(r.status).toBe(0);
    expect(w.calls()).toEqual(["prisma migrate status [copies=0]", "prisma migrate deploy [copies=1]"]);
    const [copy] = w.copies();
    expect(copy).toMatch(/project-forge\.db\.pre-migrate-\d{8}T\d{6}Z$/);
    expect(w.sql(copy, 'SELECT id FROM "User"')).toBe("u1");
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(started(w)).toBe(true);
  });

  it("history present, pending, copy fails: abort before deploy, server not started", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run({ STUB_STATUS_RC: "1", STUB_BACKUP_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual(["prisma migrate status [copies=0]"]);
    expect(w.copies()).toEqual([]);
    expect(readdirSync(path.dirname(w.db)).filter((f) => f.includes("pre-migrate"))).toEqual([]);
    expect(r.stderr).toContain("could not copy");
    expect(started(w)).toBe(false);
  });

  it("restarts with an unchanged database do not pile up identical copies", () => {
    const w = newWork();
    seedHistory(w);
    expect(w.run({ STUB_STATUS_RC: "1" }).status).toBe(0);
    expect(w.copies()).toHaveLength(1);
    const again = w.run({ STUB_STATUS_RC: "1" });
    expect(again.status).toBe(0);
    expect(w.copies()).toHaveLength(1);
    expect(again.stdout).toContain("keeping that copy");
    // A database that changed since the newest copy gets its own copy. The
    // first copy is renamed to an older stamp so the names cannot collide.
    renameSync(w.copies()[0], `${w.db}.pre-migrate-19700101T000000Z`);
    w.sql(w.db, "INSERT INTO \"User\" VALUES ('u2')");
    expect(w.run({ STUB_STATUS_RC: "1" }).status).toBe(0);
    expect(w.copies()).toHaveLength(2);
  });

  it("two different copies within the same second get distinct names instead of aborting", () => {
    const w = newWork();
    seedHistory(w);
    writeFileSync(path.join(w.dir, "bin", "date"), "#!/bin/sh\necho 20260101T000000Z\n");
    chmodSync(path.join(w.dir, "bin", "date"), 0o755);
    const env = { STUB_STATUS_RC: "1", PATH: `${path.join(w.dir, "bin")}:${process.env.PATH}` };
    expect(w.run(env).status).toBe(0);
    w.sql(w.db, "INSERT INTO \"User\" VALUES ('u2')");
    expect(w.run(env).status).toBe(0);
    expect(w.copies().map((c) => path.basename(c)).sort()).toEqual([
      "project-forge.db.pre-migrate-20260101T000000Z",
      "project-forge.db.pre-migrate-20260101T000000Z-1",
    ]);
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

  it("deploy fails on a missing database: non-zero, server not started", () => {
    const w = newWork();
    const r = w.run({ STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual(["prisma migrate deploy [copies=0]"]);
    expect(r.stderr).toContain("prisma migrate deploy failed");
    expect(started(w)).toBe(false);
  });

  it("deploy fails after a pre-migrate copy: non-zero, message names the copy", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run({ STUB_STATUS_RC: "1", STUB_DEPLOY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(w.copies()).toHaveLength(1);
    expect(r.stderr).toContain(w.copies()[0]);
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
      ["history", (w) => seedHistory(w), { STUB_STATUS_RC: "1" }],
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
      const r = w.run({ DATABASE_URL: "file:./db/rel.db", STUB_STATUS_RC: "1", STUB_DB: rel });
      expect(r.status).toBe(0);
      expect(readdirSync(path.dirname(rel)).filter((f) => f.startsWith("rel.db.pre-migrate-"))).toHaveLength(1);
      expect(started(w)).toBe(true);
    });

    it("a query string is not part of the file path", () => {
      const w = newWork();
      seedHistory(w);
      const r = w.run({ DATABASE_URL: `file:${w.db}?connection_limit=1`, STUB_STATUS_RC: "1" });
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

  it("a missing sqlite3 aborts instead of skipping the copy", () => {
    const w = newWork();
    seedHistory(w);
    const r = w.run({ STUB_STATUS_RC: "1", SQLITE3_BIN: path.join(w.dir, "bin", "no-such-sqlite3") });
    expect(r.status).not.toBe(0);
    expect(w.calls()).toEqual([]);
    expect(started(w)).toBe(false);
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
});
