// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * scripts/backup.sh must not split manual and scheduled backups across two
 * directories: with FORGE_BACKUP_DIR unset it reads the installed
 * project-forge crontab block (`crontab -l`; install-cron.sh writes the
 * directory into its lines as FORGE_BACKUP_DIR='<dir>') and refuses when
 * that block names another directory. Lines outside the BEGIN/END markers
 * and commented-out lines never decide. Tested with a stub `crontab` on PATH
 * backed by a plain file (the real crontab is never touched) and a stub
 * `docker` that records its calls and then fails the printenv read: any
 * branch that reaches docker proves the guard let the run through, a refusal
 * must leave the docker log empty.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "backup.sh");

const CRONTAB_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_CRONTAB_LOG"
if [ "\${1:-}" = -l ]; then
  [ -n "\${STUB_CRONTAB_READ_FAIL:-}" ] && { echo "bad crontab file" >&2; exit 1; }
  [ -f "\${STUB_CRONTAB_FILE:-}" ] || { echo "crontab: no crontab for tester" >&2; exit 1; }
  cat "$STUB_CRONTAB_FILE"
  exit 0
fi
echo "stub crontab: unexpected: $*" >&2
exit 90
`;

// Records the call and fails the DATABASE_URL read, which is the first
// docker call of a default-mode run: reaching it proves the guard passed.
const DOCKER_STUB = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_DOCKER_LOG"
echo "stub docker: refusing" >&2
exit 1
`;

type Env = Record<string, string | undefined>;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface Guard {
  home: string;
  backupDir: string; // the default $HOME/project-forge-backups of this run
  crontabFile: string;
  run: (env?: Env, args?: string[]) => SpawnSyncReturns<string>;
  setCrontab: (content: string) => void;
  crontabCalls: () => string[];
  dockerCalls: () => string[];
}

/** A scratch layout: stub crontab and docker first on PATH, a fake HOME. */
function newGuard(withCrontabStub = true): Guard {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-cronguard-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "docker"), DOCKER_STUB);
  chmodSync(path.join(bin, "docker"), 0o755);
  if (withCrontabStub) {
    writeFileSync(path.join(bin, "crontab"), CRONTAB_STUB);
    chmodSync(path.join(bin, "crontab"), 0o755);
  }
  const home = path.join(dir, "home");
  mkdirSync(home);
  const crontabFile = path.join(dir, "crontab.store");
  const crontabLog = path.join(dir, "crontab.log");
  const dockerLog = path.join(dir, "docker.log");
  const readLog = (f: string) =>
    existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : [];
  return {
    home,
    backupDir: path.join(home, "project-forge-backups"),
    crontabFile,
    run: (env = {}, args = []) =>
      spawnSync("sh", [SCRIPT, ...args], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 30_000,
        env: envFor({
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          STUB_CRONTAB_FILE: crontabFile,
          STUB_CRONTAB_LOG: crontabLog,
          STUB_DOCKER_LOG: dockerLog,
          ...env,
        }),
      }),
    setCrontab: (content) => writeFileSync(crontabFile, content),
    crontabCalls: () => readLog(crontabLog),
    dockerCalls: () => readLog(dockerLog),
  };
}
const envFor = (e: Env): NodeJS.ProcessEnv => e as unknown as NodeJS.ProcessEnv;

// The marker lines of the installed block, read from install-cron.sh so a
// change there cannot silently detach backup.sh (pinned in the last test).
const marker = (file: string, name: "BEGIN" | "END") => {
  const m = readFileSync(path.join(ROOT, "scripts", file), "utf-8").match(new RegExp(`^\\s*${name}='(.*)'$`, "m"));
  if (!m) throw new Error(`${name} marker not found in ${file}`);
  return m[1];
};
const BEGIN = marker("install-cron.sh", "BEGIN");
const END = marker("install-cron.sh", "END");
const block = (...lines: string[]) => `${BEGIN}\n${lines.join("\n")}\n${END}\n`;
const pruneBlock = (dir: string) => block(pruneLine(dir), backupLine(dir), checkLine(dir));

const backupLine = (dir: string) =>
  `15 3 * * * cd '/home/tester/project-forge' && FORGE_BACKUP_DIR='${dir}' sh ./scripts/backup.sh >> '${dir}/cron.log' 2>&1`;
const checkLine = (dir: string) =>
  `15 4 * * * cd '/home/tester/project-forge' && FORGE_BACKUP_DIR='${dir}' sh ./scripts/backup.sh --check-fresh 2 >> '${dir}/cron.log' 2>&1`;
const pruneLine = (dir: string) =>
  `0 * * * * cd '/home/tester/project-forge' && docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} + >> '${dir}/cron.log' 2>&1`;

describe("scripts/backup.sh: manual and scheduled backups share one directory", () => {
  it("unset FORGE_BACKUP_DIR, no crontab at all: the $HOME default stands and the run proceeds", () => {
    const g = newGuard();
    const r = g.run();
    expect(r.stdout).toContain(`backup directory: ${g.backupDir}`);
    expect(r.stderr).toContain("cannot read DATABASE_URL"); // got past the guard, to docker
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("unset FORGE_BACKUP_DIR, a crontab without project-forge lines: the default stands", () => {
    const g = newGuard();
    g.setCrontab("0 * * * * /usr/bin/true\n");
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("unset FORGE_BACKUP_DIR, the installed block names another directory: refuses and names both paths and the rerun command", () => {
    const g = newGuard();
    g.setCrontab(pruneBlock("/var/backups/project-forge"));
    const r = g.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("/var/backups/project-forge");
    expect(r.stderr).toContain(g.backupDir);
    expect(r.stderr).toContain("FORGE_BACKUP_DIR='/var/backups/project-forge' make backup");
    expect(r.stderr).toContain("Nothing was written.");
    expect(g.dockerCalls()).toEqual([]);
    expect(existsSync(g.backupDir)).toBe(false);
  });

  it("unset FORGE_BACKUP_DIR, the installed block names the same directory as the default: proceeds", () => {
    const g = newGuard();
    g.setCrontab(block(backupLine(g.backupDir), checkLine(g.backupDir)));
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(r.stderr).not.toContain("drift apart");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("a quoted cron directory containing spaces is read whole", () => {
    const g = newGuard();
    const spaced = path.join(g.home, "my backups");
    g.setCrontab(block(backupLine(spaced)));
    const r = g.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`FORGE_BACKUP_DIR='${spaced}' make backup`);
    expect(g.dockerCalls()).toEqual([]);
  });

  it("an unquoted FORGE_BACKUP_DIR value on a hand-made line inside the block is recognized too", () => {
    const g = newGuard();
    g.setCrontab(block("15 3 * * * cd '/checkout' && FORGE_BACKUP_DIR=/var/backups/manual sh ./scripts/backup.sh"));
    const r = g.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("/var/backups/manual");
    expect(g.dockerCalls()).toEqual([]);
  });

  it("several backup lines in the block: the first decides", () => {
    const g = newGuard();
    g.setCrontab(block(backupLine("/var/backups/first"), backupLine("/var/backups/second")));
    const r = g.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("/var/backups/first");
    expect(r.stderr).not.toContain("/var/backups/second");
  });

  it("FORGE_BACKUP_DIR set: it wins, the crontab is never consulted", () => {
    const g = newGuard();
    g.setCrontab(pruneBlock("/var/backups/project-forge"));
    const custom = path.join(g.home, "chosen");
    const r = g.run({ FORGE_BACKUP_DIR: custom });
    expect(r.stdout).toContain(`backup directory: ${custom}`);
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(g.crontabCalls()).toEqual([]);
  });

  it("FORGE_BACKUP_DIR empty counts as unset: the guard applies", () => {
    const g = newGuard();
    g.setCrontab(pruneBlock("/var/backups/project-forge"));
    const r = g.run({ FORGE_BACKUP_DIR: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("drift apart");
    expect(g.dockerCalls()).toEqual([]);
  });

  it("crontab -l fails for another reason: refuses instead of guessing around it", () => {
    const g = newGuard();
    const r = g.run({ STUB_CRONTAB_READ_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read the current crontab");
    expect(r.stderr).toContain("bad crontab file");
    expect(r.stderr).toContain("Nothing was written.");
    expect(g.dockerCalls()).toEqual([]);
  });

  it("no crontab program on PATH: treated as no cron installed, the default stands", () => {
    const g = newGuard(false); // bin holds only the docker stub
    // /bin for the shell itself, but no /usr/bin: no crontab anywhere.
    const r = g.run({ PATH: `${path.join(path.dirname(g.home), "bin")}:/bin` });
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("FORGE_CRONTAB names the crontab program used for the check", () => {
    const g = newGuard(false); // no crontab on PATH: only FORGE_CRONTAB can answer
    const alt = path.join(path.dirname(g.home), "alt-crontab");
    writeFileSync(alt, `#!/bin/sh\ncat "${g.crontabFile}"\n`);
    chmodSync(alt, 0o755);
    writeFileSync(g.crontabFile, pruneBlock("/var/backups/project-forge"));
    const r = g.run({ FORGE_CRONTAB: alt });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FORGE_BACKUP_DIR='/var/backups/project-forge' make backup");
    expect(g.dockerCalls()).toEqual([]);
  });

  it("--check-fresh never consults the crontab", () => {
    const g = newGuard();
    g.setCrontab(pruneBlock("/var/backups/project-forge"));
    const r = g.run({}, ["--check-fresh"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no backup stamp");
    expect(g.crontabCalls()).toEqual([]);
  });

  const OLD = "/old/dir";
  const commented = `# ${backupLine(OLD)}`;

  it("a commented-out project-forge-style line outside the block does not decide", () => {
    const g = newGuard();
    g.setCrontab(`${commented}\n${block(backupLine(g.backupDir))}`);
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(r.stderr).not.toContain(OLD);
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("a commented-out line inside the block, indented or not, does not decide", () => {
    const g = newGuard();
    g.setCrontab(block(commented, `   ${commented}`, backupLine(g.backupDir)));
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("a foreign line with the same variable outside the block does not decide", () => {
    const g = newGuard();
    const foreign = "15 3 * * * FORGE_BACKUP_DIR='/other/app/dir' /usr/bin/other-app-backup";
    g.setCrontab(`${foreign}\n${block(backupLine(g.backupDir))}${foreign}\n`);
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(r.stderr).not.toContain("/other/app/dir");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("a foreign line inside the block that does not run scripts/backup.sh does not decide", () => {
    const g = newGuard();
    g.setCrontab(block("15 3 * * * FORGE_BACKUP_DIR='/other/app/dir' /usr/bin/other-app-backup", backupLine(g.backupDir)));
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("the --check-fresh line does not decide, the backup line does", () => {
    const g = newGuard();
    g.setCrontab(block(checkLine("/var/backups/check"), backupLine(g.backupDir)));
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(r.stderr).not.toContain("/var/backups/check");
  });

  it("a block on the same directory with a stale commented line above it proceeds", () => {
    const g = newGuard();
    g.setCrontab(`${commented}\n${block(backupLine(g.backupDir))}`);
    const r = g.run();
    expect(r.stderr).not.toContain("drift apart");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("a block with a differing directory still refuses, even below a commented old line", () => {
    const g = newGuard();
    g.setCrontab(`${commented}\n${block(backupLine("/var/backups/project-forge"))}`);
    const r = g.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FORGE_BACKUP_DIR='/var/backups/project-forge' make backup");
    expect(r.stderr).not.toContain(OLD);
    expect(g.dockerCalls()).toEqual([]);
  });

  it("an uncommented backup.sh line outside the block (a hand-made twin above it) does not decide", () => {
    const g = newGuard();
    g.setCrontab(`${backupLine("/var/backups/outside")}\n${block(backupLine(g.backupDir))}`);
    const r = g.run();
    expect(r.stderr).toContain("cannot read DATABASE_URL");
    expect(r.stderr).not.toContain("/var/backups/outside");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("lines after the END marker do not decide", () => {
    const g = newGuard();
    g.setCrontab(`${block(backupLine(g.backupDir))}${backupLine("/var/backups/after")}\n`);
    const r = g.run();
    expect(r.stderr).not.toContain("/var/backups/after");
    expect(g.dockerCalls().length).toBeGreaterThan(0);
  });

  it("a truncated block (BEGIN without END) is refused, even on the same directory", () => {
    const g = newGuard();
    g.setCrontab(`${BEGIN}\n${backupLine(g.backupDir)}\n`);
    const r = g.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("without its END marker");
    expect(r.stderr).toContain("Nothing was written.");
    expect(g.dockerCalls()).toEqual([]);
  });

  it("an unquoted value ends at whitespace or a shell metacharacter", () => {
    for (const [tail, want] of [
      [";sh ./scripts/backup.sh", "/var/b"],
      ["&& sh ./scripts/backup.sh", "/var/b"],
      ["|cat sh ./scripts/backup.sh", "/var/b"],
      [" sh ./scripts/backup.sh", "/var/b"],
    ]) {
      const g = newGuard();
      g.setCrontab(block(`15 3 * * * cd /x && FORGE_BACKUP_DIR=/var/b${tail}`));
      const r = g.run();
      expect(r.status, tail).toBe(1);
      expect(r.stderr, tail).toContain(`FORGE_BACKUP_DIR='${want}' make backup`);
    }
  });

  it("backup.sh carries the same block markers as install-cron.sh", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toContain(`cron_begin='${marker("install-cron.sh", "BEGIN")}'`);
    expect(src).toContain(`cron_end='${marker("install-cron.sh", "END")}'`);
  });
});
