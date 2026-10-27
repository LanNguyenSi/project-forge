// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * scripts/backup.sh takes a routine backup of the production SQLite database
 * from the host: it resolves the database path from the running container's
 * DATABASE_URL, copies it with `sqlite3 .backup` inside the container (never a
 * cp of the live file), runs PRAGMA integrity_check on the copy, copies it out
 * with `docker compose cp`, publishes it atomically with mode 600 and rotates
 * the old backups. It is tested with a stub `docker` on PATH whose
 * `compose exec -T app <cmd>` runs <cmd> for real against a real SQLite file
 * in a temp dir (the "container" filesystem is the host temp dir), whose
 * `compose cp` copies and whose printenv answers with STUB_DATABASE_URL, plus
 * the real sqlite3. Failures are injected per call with STUB_* variables.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "backup.sh");

function realSqlite3(): string {
  const r = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf-8" });
  const p = r.stdout.trim();
  if (r.status !== 0 || !p) throw new Error("these tests need a sqlite3 binary on PATH");
  return p;
}
const SQLITE3 = realSqlite3();

const DOCKER_STUB = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_DOCKER_LOG"
[ "\${1:-}" = compose ] || { echo "stub docker: expected compose: $*" >&2; exit 70; }
shift
if [ "\${1:-}" = -f ]; then shift 2; fi
case "\${1:-}" in
  exec)
    shift
    [ "\${1:-}" = -T ] && shift
    [ "\${1:-}" = app ] || { echo "stub docker: wrong service: $*" >&2; exit 71; }
    shift
    if [ "\${1:-}" = printenv ]; then
      [ -n "\${STUB_PRINTENV_FAIL:-}" ] && exit 1
      printf '%s\\n' "\${STUB_DATABASE_URL:-}"
      exit 0
    fi
    if [ "\${1:-}" = sqlite3 ] && [ "$#" -ge 3 ]; then
      case "$3" in
        .backup*)
          [ -n "\${STUB_BACKUP_FAIL:-}" ] && { echo "stub sqlite3: disk full" >&2; exit 1; }
          ;;
        *integrity_check*)
          [ -n "\${STUB_INTEGRITY_RC:-}" ] && exit "\${STUB_INTEGRITY_RC}"
          [ -n "\${STUB_INTEGRITY_ANSWER+x}" ] && { printf '%s\\n' "$STUB_INTEGRITY_ANSWER"; exit 0; }
          ;;
      esac
    fi
    exec "$@"
    ;;
  cp)
    shift
    [ -n "\${STUB_CP_FAIL:-}" ] && { echo "stub docker: compose cp failed" >&2; exit 1; }
    src=\${1#app:}
    [ "$src" != "$1" ] || { echo "stub docker: source must be service:path: $1" >&2; exit 1; }
    [ -f "$src" ] || { echo "stub docker: no such container file: $src" >&2; exit 1; }
    exec cp "$src" "$2"
    ;;
esac
echo "stub docker: unhandled: $*" >&2
exit 72
`;

type Env = Record<string, string | undefined>;
const envFor = (e: Env): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface Backup {
  dir: string;
  home: string;
  backupDir: string; // the default $HOME/project-forge-backups of this run
  db: string; // the container database this run's DATABASE_URL points at
  run: (env?: Env, dbUrl?: string) => SpawnSyncReturns<string>;
  calls: () => string[];
  defaultBackups: () => string[];
  matching: (files: string[]) => string[]; // names of the rotation name shape
  sql: (file: string, statement: string) => string;
  seed: (file: string, value: string) => void;
  tmpLeft: () => string; // a .tmp-backup. file left in the "container", or ""
}

/** A scratch layout: stub docker first on PATH, a fake HOME, a "container" dir. */
function newBackup(seedDb = true): Backup {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-backup-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "docker"), DOCKER_STUB);
  chmodSync(path.join(bin, "docker"), 0o755);
  const home = path.join(dir, "home");
  mkdirSync(home);
  const db = path.join(dir, "container", "data", "project-forge.db");
  mkdirSync(path.dirname(db), { recursive: true });
  const dockerLog = path.join(dir, "docker.log");
  const sql = (file: string, statement: string) => {
    const r = spawnSync(SQLITE3, [file, statement], { encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const seed = (file: string, value: string) => {
    sql(file, `CREATE TABLE IF NOT EXISTS t (a); INSERT INTO t (a) VALUES ('${value}');`);
  };
  if (seedDb) {
    seed(db, "alpha");
    seed(db, "beta");
  }
  return {
    dir,
    home,
    backupDir: path.join(home, "project-forge-backups"),
    db,
    sql,
    seed,
    run: (env = {}, dbUrl) =>
      spawnSync("sh", [SCRIPT], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 60_000,
        killSignal: "SIGKILL",
        env: envFor({
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          STUB_DOCKER_LOG: dockerLog,
          STUB_DATABASE_URL: dbUrl ?? `file:${db}`,
          ...env,
        }),
      }),
    calls: () =>
      existsSync(dockerLog) ? readFileSync(dockerLog, "utf-8").trim().split("\n").filter(Boolean) : [],
    defaultBackups: () => (existsSync(path.join(home, "project-forge-backups")) ? readdirSync(path.join(home, "project-forge-backups")) : []),
    matching: (files) => files.filter((f) => /^project-forge-\d{8}T\d{6}Z(-\d+)?\.db$/.test(f)),
    tmpLeft: () => {
      const hits = readdirSync(path.dirname(db)).filter((f) => f.includes(".tmp-backup."));
      return hits[0] ?? "";
    },
  };
}

const NAME = /^project-forge-\d{8}T\d{6}Z(-\d+)?\.db$/;
const oldName = (stamp: string) => `project-forge-${stamp}.db`;

describe("scripts/backup.sh", () => {
  it("success: .backup inside the container, integrity check, mode 600, content matches", () => {
    const w = newBackup();
    const r = w.run();
    expect(r.status, r.stderr).toBe(0);
    const names = w.defaultBackups();
    expect(names).toHaveLength(1);
    const [name] = names;
    expect(name).toMatch(NAME);
    expect(name).not.toContain(".pre-migrate-");
    const file = path.join(w.backupDir, name);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(w.sql(file, "SELECT group_concat(a) FROM t ORDER BY a")).toBe("alpha,beta");
    expect(r.stdout).toContain(`backup written: ${file}`);
    // No partial artifacts: the temporary host file is gone (the directory
    // holds only the published backup) and the container temp was removed.
    expect(readdirSync(w.backupDir)).toEqual([name]);
    expect(w.tmpLeft()).toBe("");
    const calls = w.calls();
    expect(calls[0]).toBe("docker compose exec -T app printenv DATABASE_URL");
    // The copy is a consistent .backup, never a cp of the live file.
    expect(calls.some((c) => c.includes(`sqlite3 ${w.db} .backup `))).toBe(true);
    expect(calls.some((c) => c.includes("cp app:"))).toBe(true);
    expect(calls.filter((c) => c.includes(" cp ")).every((c) => c.includes(".tmp-backup."))).toBe(true);
    // The copy-out lands on a temporary name, never a final-shaped one: the
    // final name only appears with the last mv (atomic publish).
    const cp = calls.find((c) => c.includes(" cp app:"));
    expect(cp?.trim()).toMatch(/ \S+\.part$/);
    expect(cp).not.toMatch(/project-forge-\d{8}T\d{6}Z/);
    expect(calls.some((c) => c.includes("PRAGMA integrity_check;"))).toBe(true);
    // The trap removed the container temp at the end of the run.
    expect(calls[calls.length - 1]).toContain("rm -f ");
    expect(calls[calls.length - 1]).toContain(".tmp-backup.");
  });

  it("the container's own DATABASE_URL is used, not the compose default path", () => {
    const w = newBackup(false);
    const other = path.join(w.dir, "container", "data", "custom.db");
    w.seed(other, "gamma");
    w.seed(w.db, "never-backed-up");
    const r = w.run({}, `file:${other}`);
    expect(r.status, r.stderr).toBe(0);
    const [name] = w.defaultBackups();
    expect(w.sql(path.join(w.backupDir, name), "SELECT group_concat(a) FROM t")).toBe("gamma");
    expect(w.calls().some((c) => c.includes(`sqlite3 ${other} .backup `))).toBe(true);
    expect(w.calls().some((c) => c.includes(`sqlite3 ${w.db} .backup `))).toBe(false);
  });

  it("a relative file: path resolves against /app/prisma, like Prisma in the container", () => {
    const w = newBackup(false);
    w.run({}, "file:./db/rel.db");
    expect(w.calls().some((c) => c.includes("sqlite3 /app/prisma/db/rel.db .backup "))).toBe(true);
  });

  it("a second run in the same second gets a -1 name, then -2", () => {
    const w = newBackup();
    writeFileSync(path.join(w.dir, "bin", "date"), "#!/bin/sh\necho 20260101T000000Z\n");
    chmodSync(path.join(w.dir, "bin", "date"), 0o755);
    for (const n of [1, 2, 3]) expect(w.run().status, `run ${n}`).toBe(0);
    expect(w.defaultBackups().sort()).toEqual([
      "project-forge-20260101T000000Z-1.db",
      "project-forge-20260101T000000Z-2.db",
      "project-forge-20260101T000000Z.db",
    ]);
  });

  it(".backup fails in the container: non-zero, nothing published", () => {
    const w = newBackup();
    const r = w.run({ STUB_BACKUP_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(".backup");
    expect(r.stderr).toContain("Nothing was written");
    expect(w.defaultBackups()).toEqual([]);
    expect(w.tmpLeft()).toBe("");
  });

  it("integrity_check answers something else than ok: non-zero, nothing published, container temp removed", () => {
    const w = newBackup();
    const r = w.run({ STUB_INTEGRITY_ANSWER: "*** in database main ***\\nPage 1 is corrupt" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("integrity_check");
    expect(r.stderr).toContain("Nothing was written");
    expect(w.defaultBackups()).toEqual([]);
    expect(w.tmpLeft()).toBe("");
  });

  it("integrity_check command itself fails: non-zero, nothing published", () => {
    const w = newBackup();
    const r = w.run({ STUB_INTEGRITY_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("integrity_check");
    expect(w.defaultBackups()).toEqual([]);
    expect(w.tmpLeft()).toBe("");
  });

  it("compose cp fails: non-zero, nothing published, container temp removed", () => {
    const w = newBackup();
    const r = w.run({ STUB_CP_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("compose cp");
    expect(r.stderr).toContain("Nothing was written");
    expect(w.defaultBackups()).toEqual([]);
    expect(w.tmpLeft()).toBe("");
  });

  describe("FORGE_BACKUP_DIR (set wins over the default; empty counts as unset)", () => {
    it("unset: writes into $HOME/project-forge-backups, outside the checkout", () => {
      const w = newBackup();
      const r = w.run();
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(w.backupDir)).toHaveLength(1);
      expect(readdirSync(w.dir)).not.toContain("project-forge-backups");
    });

    it("set: that directory is used and the $HOME default is never created", () => {
      const w = newBackup();
      const custom = path.join(w.dir, "backups-here");
      const r = w.run({ FORGE_BACKUP_DIR: custom });
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(custom)).toHaveLength(1);
      expect(existsSync(w.backupDir)).toBe(false);
    });

    it("empty: counts as unset, so the $HOME default applies", () => {
      const w = newBackup();
      const r = w.run({ FORGE_BACKUP_DIR: "" });
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(w.backupDir)).toHaveLength(1);
    });

    it("set to a path that is not a directory: refuses, nothing published", () => {
      const w = newBackup();
      const blocker = path.join(w.dir, "blocker");
      writeFileSync(blocker, "not a directory\n");
      const r = w.run({ FORGE_BACKUP_DIR: blocker });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(blocker);
      expect(existsSync(w.backupDir)).toBe(false);
    });
  });

  describe("FORGE_BACKUP_KEEP (set wins; unset or empty means 14; zero and non-numeric are refused)", () => {
    /** n older backups, ascending stamps 20200101T000001Z ... . */
    const seedOld = (w: Backup, n: number) => {
      mkdirSync(w.backupDir, { recursive: true });
      for (let i = 1; i <= n; i++) {
        const stamp = `20200101T0000${String(i).padStart(2, "0")}Z`;
        writeFileSync(path.join(w.backupDir, oldName(stamp)), "x");
      }
    };

    it("set to 2: keeps exactly the new backup and the newest old one", () => {
      const w = newBackup();
      seedOld(w, 3);
      const r = w.run({ FORGE_BACKUP_KEEP: "2" });
      expect(r.status, r.stderr).toBe(0);
      const after = w.defaultBackups();
      expect(w.matching(after)).toHaveLength(2);
      expect(after).toContain(oldName("20200101T000003Z"));
      expect(after).not.toContain(oldName("20200101T000001Z"));
      expect(after).not.toContain(oldName("20200101T000002Z"));
      expect(w.matching(after).some((f) => NAME.test(f) && !f.startsWith("project-forge-2020"))).toBe(true);
    });

    it("unset: the default 14 applies (fifteen old plus the new one, fourteen survive)", () => {
      const w = newBackup();
      seedOld(w, 15);
      const r = w.run();
      expect(r.status, r.stderr).toBe(0);
      const after = w.defaultBackups();
      expect(after).toHaveLength(14);
      expect(after).not.toContain(oldName("20200101T000001Z"));
      expect(after).not.toContain(oldName("20200101T000002Z"));
      expect(after).toContain(oldName("20200101T000003Z"));
    });

    it("empty: counts as unset, so the default 14 applies", () => {
      const w = newBackup();
      seedOld(w, 15);
      const r = w.run({ FORGE_BACKUP_KEEP: "" });
      expect(r.status, r.stderr).toBe(0);
      expect(w.defaultBackups()).toHaveLength(14);
    });

    // The refusals come before anything else: no docker call, no directory.
    for (const [what, value] of [
      ["non-numeric (abc)", "abc"],
      ["zero", "0"],
      ["negative (-1)", "-1"],
      ["mixed (2x)", "2x"],
    ] as const) {
      it(`refuses ${what} before touching the container, nothing written`, () => {
        const w = newBackup();
        const r = w.run({ FORGE_BACKUP_KEEP: value });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("FORGE_BACKUP_KEEP");
        expect(w.calls()).toEqual([]);
        expect(existsSync(w.backupDir)).toBe(false);
      });
    }
  });

  it("rotation only matches the backup name shape: a .pre-migrate- file and unrelated files survive", () => {
    const w = newBackup();
    mkdirSync(w.backupDir, { recursive: true });
    const others = [
      // Match the directory's file prefix but never the rotation name:
      "project-forge-old.db",
      "project-forge-20200101T000000Z.db.bak",
      "project-forge-20990101T000000Z.db.pre-migrate-20990101T000000Z",
      "project-forge.db.pre-migrate-20990101T000000Z",
      "notes.txt",
      ".hidden-project-forge-20200101T000001Z.db",
    ];
    const older = [oldName("20200101T000001Z"), oldName("20200102T000001Z"), oldName("20200103T000001Z")];
    for (const f of [...others, ...older]) writeFileSync(path.join(w.backupDir, f), "x");
    const r = w.run({ FORGE_BACKUP_KEEP: "2" });
    expect(r.status, r.stderr).toBe(0);
    const after = w.defaultBackups();
    // Of its own shape only the two newest remain (the new backup + 20200103).
    expect(w.matching(after)).toHaveLength(2);
    expect(after).toContain(oldName("20200103T000001Z"));
    expect(after).not.toContain(older[0]);
    expect(after).not.toContain(older[1]);
    // Nothing else in the directory was ever a candidate.
    for (const f of others) expect(after, f).toContain(f);
  });

  it("rotation compares the -<n> suffix as a number: -10 is newer than -2", () => {
    const w = newBackup();
    mkdirSync(w.backupDir, { recursive: true });
    const base = "20200101T000000Z";
    for (const f of [`project-forge-${base}.db`, `project-forge-${base}-2.db`, `project-forge-${base}-10.db`]) {
      writeFileSync(path.join(w.backupDir, f), "x");
    }
    const r = w.run({ FORGE_BACKUP_KEEP: "3" });
    expect(r.status, r.stderr).toBe(0);
    const after = w.defaultBackups();
    // Kept: the new backup, -10 and -2; the unprefixed one (n = 0) rotated out.
    expect(w.matching(after)).toHaveLength(3);
    expect(after).toContain(`project-forge-${base}-10.db`);
    expect(after).toContain(`project-forge-${base}-2.db`);
    expect(after).not.toContain(`project-forge-${base}.db`);
  });

  describe("the app container is the only source of truth", () => {
    it("printenv fails (app not running): non-zero, nothing written", () => {
      const w = newBackup();
      const r = w.run({ STUB_PRINTENV_FAIL: "1" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot read DATABASE_URL");
      expect(readdirSync(w.home)).toEqual([]);
    });

    it("DATABASE_URL empty in the container: non-zero, nothing written", () => {
      const w = newBackup();
      const r = w.run({}, "");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("empty in the app container");
      expect(readdirSync(w.home)).toEqual([]);
    });

    it("DATABASE_URL not a file: URL: non-zero, nothing written", () => {
      const w = newBackup();
      const r = w.run({}, "postgresql://u:p@h/db");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("not a SQLite file: URL");
      expect(readdirSync(w.home)).toEqual([]);
    });
  });

  describe("COMPOSE_FILE passes through to every docker compose call (never hard-coded)", () => {
    it("set: every call carries -f <file>", () => {
      const w = newBackup();
      const r = w.run({ COMPOSE_FILE: "docker-compose.staging.yml" });
      expect(r.status, r.stderr).toBe(0);
      const calls = w.calls();
      expect(calls.length).toBeGreaterThan(3);
      for (const c of calls) expect(c.startsWith("docker compose -f docker-compose.staging.yml ")).toBe(true);
    });

    it("unset: no call carries -f", () => {
      const w = newBackup();
      const r = w.run();
      expect(r.status, r.stderr).toBe(0);
      const calls = w.calls();
      expect(calls.length).toBeGreaterThan(3);
      for (const c of calls) expect(c, c).not.toMatch(/compose -f/);
    });
  });
});
