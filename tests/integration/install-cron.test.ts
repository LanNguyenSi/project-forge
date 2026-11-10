// @vitest-environment node
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * scripts/install-cron.sh puts the prune, backup and freshness-check cron
 * entries into one marked block of the invoking user's crontab. It is tested with a stub
 * `crontab` on PATH backed by a plain file: `-l` prints it (or answers "no
 * crontab for user" when the file is missing), `<file>` replaces it. The real
 * crontab of the machine is never touched.
 */

const ROOT = realpathSync(path.resolve(__dirname, "..", ".."));
const SCRIPT = path.join(ROOT, "scripts", "install-cron.sh");

const CRONTAB_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_CRONTAB_LOG"
if [ "\${1:-}" = -l ]; then
  [ -n "\${STUB_CRONTAB_READ_FAIL:-}" ] && { echo "crontab: permission denied" >&2; exit 1; }
  [ -f "$STUB_CRONTAB_FILE" ] || { echo "crontab: no crontab for tester" >&2; exit 1; }
  cat "$STUB_CRONTAB_FILE"
  exit 0
fi
[ -n "\${STUB_CRONTAB_WRITE_FAIL:-}" ] && exit 1
cp "$1" "$STUB_CRONTAB_FILE"
`;

const BEGIN = "# BEGIN project-forge (managed by scripts/install-cron.sh, do not edit)";
const END = "# END project-forge";

type Env = Record<string, string | undefined>;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

interface Cron {
  dir: string;
  file: string; // the stub's crontab store
  run: (env?: Env, args?: string[]) => SpawnSyncReturns<string>;
  set: (content: string) => void;
  content: () => string | null; // null when no crontab exists
  calls: () => string[];
}

function newCron(): Cron {
  const dir = mkdtempSync(path.join(tmpdir(), "pf-cron-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "crontab"), CRONTAB_STUB);
  chmodSync(path.join(bin, "crontab"), 0o755);
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  const file = path.join(dir, "crontab.store");
  const log = path.join(dir, "crontab.log");
  return {
    dir,
    file,
    run: (env = {}, args = []) =>
      spawnSync("sh", [SCRIPT, ...args], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
          TMPDIR: tmp,
          STUB_CRONTAB_FILE: file,
          STUB_CRONTAB_LOG: log,
          ...env,
        } as unknown as NodeJS.ProcessEnv,
      }),
    set: (content) => writeFileSync(file, content),
    content: () => (existsSync(file) ? readFileSync(file, "utf-8") : null),
    calls: () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : []),
  };
}

// The installer creates this directory, so it must be somewhere we may write.
const BACKUP_ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "pf-cron-bk-")));
afterAll(() => rmSync(BACKUP_ROOT, { recursive: true, force: true }));
const BACKUP_DIR = path.join(BACKUP_ROOT, "backups");
const lines = (s: string | null) => (s ?? "").split("\n");
const blockOf = (s: string | null) => {
  const l = lines(s);
  const a = l.indexOf(BEGIN);
  return a < 0 ? [] : l.slice(a, l.indexOf(END) + 1);
};
const backupLine = (s: string | null) =>
  blockOf(s).find((l) => l.includes("scripts/backup.sh") && !l.includes("--check-fresh")) ?? "";
const checkLine = (s: string | null) => blockOf(s).find((l) => l.includes("--check-fresh")) ?? "";
const pruneLine = (s: string | null) => blockOf(s).find((l) => l.includes("find /tmp/project-forge")) ?? "";
const count = (s: string | null, what: string) => lines(s).filter((l) => l === what).length;

describe("scripts/install-cron.sh", () => {
  it("fresh install: no crontab yet, the block holds the prune, backup and freshness entries with absolute paths", () => {
    const c = newCron();
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR });
    expect(r.status, r.stderr).toBe(0);
    const out = c.content();
    expect(blockOf(out)).toHaveLength(5);
    expect(pruneLine(out)).toBe(
      `0 * * * * cd '${ROOT}' && docker compose exec -T app find /tmp/project-forge -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} + >> '${BACKUP_DIR}/cron.log' 2>&1`,
    );
    expect(backupLine(out)).toBe(
      `15 3 * * * cd '${ROOT}' && FORGE_BACKUP_DIR='${BACKUP_DIR}' sh ./scripts/backup.sh >> '${BACKUP_DIR}/cron.log' 2>&1`,
    );
    expect(backupLine(out)).not.toContain("--check-fresh");
    expect(checkLine(out)).toBe(
      `15 4 * * * cd '${ROOT}' && FORGE_BACKUP_DIR='${BACKUP_DIR}' sh ./scripts/backup.sh --check-fresh 2 >> '${BACKUP_DIR}/cron.log' 2>&1`,
    );
    expect(c.calls()).toEqual(["-l", expect.stringMatching(/crontab\.\w+$|next$/)]);
  });

  it("re-run is idempotent: one block, and no second write", () => {
    const c = newCron();
    expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }).status).toBe(0);
    const first = c.content();
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR });
    expect(r.status, r.stderr).toBe(0);
    expect(c.content()).toBe(first);
    expect(count(c.content(), BEGIN)).toBe(1);
    expect(count(c.content(), END)).toBe(1);
    expect(c.calls().filter((a) => a !== "-l")).toHaveLength(1);
    expect(r.stdout).toContain("already up to date");
  });

  it("foreign entries are preserved byte for byte, and a changed block is replaced in place", () => {
    const c = newCron();
    const before = "MAILTO=ops@example.org\n# my job\n*/5 * * * * /usr/bin/true   # odd  spacing\t\n\n";
    const after = "@reboot /usr/local/bin/other --flag 'quoted'\n0 4 * * * echo 100%\\n\n";
    c.set(`${before}${BEGIN}\n0 * * * * old prune\n1 1 * * * old backup\n${END}\n${after}`);
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "04:30" });
    expect(r.status, r.stderr).toBe(0);
    const out = c.content() as string;
    expect(out.startsWith(before + BEGIN + "\n")).toBe(true);
    expect(out.endsWith(END + "\n" + after)).toBe(true);
    expect(out).not.toContain("old prune");
    expect(backupLine(out)).toMatch(/^30 4 \* \* \*/);
    // Without a block the entries are appended after the existing lines.
    const d = newCron();
    d.set(before + after);
    expect(d.run({ FORGE_BACKUP_DIR: BACKUP_DIR }).status).toBe(0);
    expect((d.content() as string).startsWith(before + after + BEGIN + "\n")).toBe(true);
  });

  it("--remove deletes only the block", () => {
    const c = newCron();
    const keep = "MAILTO=ops@example.org\n0 4 * * * /usr/bin/other\n";
    c.set(keep);
    expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }).status).toBe(0);
    const r = c.run({}, ["--remove"]);
    expect(r.status, r.stderr).toBe(0);
    expect(c.content()).toBe(keep);
  });

  it("--remove with nothing to remove writes nothing; with only the block left it leaves an empty crontab", () => {
    const c = newCron();
    c.set("0 4 * * * /usr/bin/other\n");
    const r = c.run({}, ["--remove"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("already up to date");
    expect(c.calls()).toEqual(["-l"]);
    const d = newCron();
    expect(d.run({ FORGE_BACKUP_DIR: BACKUP_DIR }).status).toBe(0);
    expect(d.run({}, ["--remove"]).status).toBe(0);
    expect(d.content()).toBe("");
    const e = newCron(); // no crontab at all
    expect(e.run({}, ["--remove"]).status).toBe(0);
    expect(e.content()).toBeNull();
  });

  it("--dry-run prints the block and never calls crontab", () => {
    const c = newCron();
    c.set("0 4 * * * /usr/bin/other\n");
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }, ["--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)[0]).toBe(BEGIN);
    expect(r.stdout).toContain("scripts/backup.sh");
    expect(r.stdout).toContain(END);
    expect(c.calls()).toEqual([]);
    expect(c.content()).toBe("0 4 * * * /usr/bin/other\n");
  });

  it("--dry-run still validates the knobs", () => {
    const c = newCron();
    expect(c.run({}, ["--dry-run"]).status).toBe(1);
  });

  describe("FORGE_BACKUP_DIR (required; unset and empty are both refused)", () => {
    for (const [label, env] of [
      ["unset", {}],
      ["empty", { FORGE_BACKUP_DIR: "" }],
    ] as const) {
      it(`${label}: refused with the reason, crontab untouched`, () => {
        const c = newCron();
        c.set("0 4 * * * /usr/bin/other\n");
        const r = c.run(env);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("FORGE_BACKUP_DIR");
        expect(r.stderr).toContain("HOME");
        expect(c.calls()).toEqual([]);
        expect(c.content()).toBe("0 4 * * * /usr/bin/other\n");
      });
    }

    it("set: used; a relative path or a quote or % in it is refused", () => {
      const c = newCron();
      expect(c.run({ FORGE_BACKUP_DIR: path.join(BACKUP_ROOT, "bk") }).status).toBe(0);
      expect(backupLine(c.content())).toContain(`FORGE_BACKUP_DIR='${path.join(BACKUP_ROOT, "bk")}'`);
      for (const bad of ["relative/dir", "/srv/it's", "/srv/100%", "/srv/a\nb"]) {
        const d = newCron();
        const r = d.run({ FORGE_BACKUP_DIR: bad });
        expect(r.status, bad).toBe(1);
        expect(d.content(), bad).toBeNull();
      }
    });
  });

  describe("FORGE_BACKUP_TIME (absent and empty mean 03:15; set wins; invalid is refused)", () => {
    it("absent: 03:15", () => {
      const c = newCron();
      c.run({ FORGE_BACKUP_DIR: BACKUP_DIR });
      expect(backupLine(c.content())).toMatch(/^15 3 \* \* \* /);
    });
    it("empty: 03:15", () => {
      const c = newCron();
      c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "" });
      expect(backupLine(c.content())).toMatch(/^15 3 \* \* \* /);
    });
    it("set: minute and hour without leading zeros, 08:09 is not octal", () => {
      const c = newCron();
      c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "08:09" });
      expect(backupLine(c.content())).toMatch(/^9 8 \* \* \* /);
      const d = newCron();
      d.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "00:00" });
      expect(backupLine(d.content())).toMatch(/^0 0 \* \* \* /);
      const e = newCron();
      e.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "23:59" });
      expect(backupLine(e.content())).toMatch(/^59 23 \* \* \* /);
    });
    for (const bad of ["24:00", "03:60", "3:15", "0315", "ab:cd", "03:15:00"]) {
      it(`'${bad}' is refused, nothing written`, () => {
        const c = newCron();
        const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: bad });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("FORGE_BACKUP_TIME");
        expect(c.content()).toBeNull();
      });
    }
  });

  describe("the --check-fresh freshness entry (one hour after the backup, wrapping 23 to 00)", () => {
    const checkFor = (t: string, dir = BACKUP_DIR) =>
      `${t} * * * cd '${ROOT}' && FORGE_BACKUP_DIR='${dir}' sh ./scripts/backup.sh --check-fresh 2 >> '${dir}/cron.log' 2>&1`;

    it("dry-run prints exactly three entries between the markers, the last being the freshness check", () => {
      const c = newCron();
      const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }, ["--dry-run"]);
      expect(r.status, r.stderr).toBe(0);
      const block = blockOf(r.stdout);
      expect(block).toHaveLength(5);
      expect(block.filter((l) => !l.startsWith("#"))).toHaveLength(3);
      expect(checkLine(r.stdout)).toBe(checkFor("15 4"));
      expect(c.calls()).toEqual([]);
    });

    for (const [backup, check] of [
      ["03:15", "15 4"],
      ["00:00", "0 1"],
      ["08:09", "9 9"],
      ["22:30", "30 23"],
    ] as const) {
      it(`FORGE_BACKUP_TIME ${backup}: the check runs one hour later at ${check}, same minute`, () => {
        const c = newCron();
        expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: backup }).status).toBe(0);
        const out = c.content();
        expect(backupLine(out)).toContain(" sh ./scripts/backup.sh >> ");
        expect(checkLine(out)).toBe(checkFor(check));
      });
    }

    it("23:30 wraps the check to 00:30 (still one hour after)", () => {
      const c = newCron();
      expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "23:30" }).status).toBe(0);
      expect(backupLine(c.content())).toMatch(/^30 23 \* \* \* /);
      expect(checkLine(c.content())).toBe(checkFor("30 0"));
    });

    it("quotes a backup directory with a space exactly like the backup entry", () => {
      const c = newCron();
      const dir = path.join(BACKUP_ROOT, "sp ace");
      expect(c.run({ FORGE_BACKUP_DIR: dir }).status).toBe(0);
      const out = c.content();
      expect(checkLine(out)).toBe(checkFor("15 4", dir));
      const b = backupLine(out);
      for (const frag of [`cd '${ROOT}'`, `FORGE_BACKUP_DIR='${dir}'`, `>> '${dir}/cron.log' 2>&1`]) {
        expect(checkLine(out), frag).toContain(frag);
        expect(b, frag).toContain(frag);
      }
    });

    it("a re-install replaces the block and leaves exactly one check entry", () => {
      const c = newCron();
      expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }).status).toBe(0);
      expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_TIME: "05:45" }).status).toBe(0);
      const out = c.content();
      expect(lines(out).filter((l) => l.includes("--check-fresh"))).toHaveLength(1);
      expect(count(out, BEGIN)).toBe(1);
      expect(checkLine(out)).toBe(checkFor("45 6"));
    });

    it("--remove takes the whole block down, check entry included", () => {
      const c = newCron();
      const keep = "MAILTO=ops@example.org\n0 4 * * * /usr/bin/other\n";
      c.set(keep);
      expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }).status).toBe(0);
      expect(c.content()).toContain("--check-fresh");
      expect(c.run({}, ["--remove"]).status).toBe(0);
      expect(c.content()).toBe(keep);
      expect(c.content()).not.toContain("--check-fresh");
    });
  });

  describe("FORGE_BACKUP_LOG (absent and empty mean $FORGE_BACKUP_DIR/cron.log; set wins)", () => {
    it("absent and empty: the default under the backup dir", () => {
      for (const env of [{}, { FORGE_BACKUP_LOG: "" }]) {
        const c = newCron();
        c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, ...env });
        expect(backupLine(c.content())).toContain(`>> '${BACKUP_DIR}/cron.log' 2>&1`);
        expect(pruneLine(c.content())).toContain(`>> '${BACKUP_DIR}/cron.log' 2>&1`);
        expect(checkLine(c.content())).toContain(`>> '${BACKUP_DIR}/cron.log' 2>&1`);
      }
    });
    it("set: all three entries log there", () => {
      const c = newCron();
      c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_LOG: path.join(BACKUP_ROOT, "forge.log") });
      expect(backupLine(c.content())).toContain(`>> '${path.join(BACKUP_ROOT, "forge.log")}' 2>&1`);
      expect(pruneLine(c.content())).toContain(`>> '${path.join(BACKUP_ROOT, "forge.log")}' 2>&1`);
      expect(checkLine(c.content())).toContain(`>> '${path.join(BACKUP_ROOT, "forge.log")}' 2>&1`);
    });
    it("a relative path is refused", () => {
      const c = newCron();
      const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_BACKUP_LOG: "forge.log" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("FORGE_BACKUP_LOG");
      expect(c.content()).toBeNull();
    });
  });

  it("a crontab that cannot be read is not overwritten", () => {
    const c = newCron();
    c.set("0 4 * * * /usr/bin/other\n");
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, STUB_CRONTAB_READ_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read the current crontab");
    expect(c.content()).toBe("0 4 * * * /usr/bin/other\n");
    expect(c.calls().filter((a) => a !== "-l")).toEqual([]);
  });

  it("a failing crontab write exits non-zero", () => {
    const c = newCron();
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, STUB_CRONTAB_WRITE_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("installing the new crontab failed");
  });

  describe("damaged markers are refused, nothing written", () => {
    for (const [label, content] of [
      ["BEGIN without END", `${BEGIN}\n0 * * * * x\n0 4 * * * keep\n`],
      ["END without BEGIN", `0 4 * * * keep\n${END}\n`],
      ["two blocks", `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`],
      ["END before BEGIN", `${END}\n${BEGIN}\n`],
    ] as const) {
      it(label, () => {
        const c = newCron();
        c.set(content);
        for (const args of [[], ["--remove"]]) {
          const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }, args);
          expect(r.status, `${label} ${args}`).toBe(1);
          expect(c.content()).toBe(content);
        }
      });
    }
  });

  it("--dry-run and --remove together, and unknown arguments, are refused", () => {
    const c = newCron();
    expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }, ["--dry-run", "--remove"]).status).toBe(1);
    const r = c.run({ FORGE_BACKUP_DIR: BACKUP_DIR }, ["--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown argument");
    expect(c.calls()).toEqual([]);
  });

  it("on a fresh host the generated lines run under cron's minimal env: directories and log exist, docker is reached", () => {
    const c = newCron();
    const backupDir = path.join(c.dir, "fresh", "backups"); // does not exist yet
    expect(c.run({ FORGE_BACKUP_DIR: backupDir }).status).toBe(0);
    expect(existsSync(backupDir)).toBe(true);
    const dockerLog = path.join(c.dir, "docker.log");
    const stubBin = path.join(c.dir, "stubbin");
    mkdirSync(stubBin);
    writeFileSync(path.join(stubBin, "docker"), `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> '${dockerLog}'\nexit 1\n`);
    chmodSync(path.join(stubBin, "docker"), 0o755);
    const entries = blockOf(c.content()).filter((l) => !l.startsWith("#"));
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      const command = entry.split(/^\S+ \S+ \S+ \S+ \S+ /)[1];
      const r = spawnSync("env", ["-i", `PATH=${stubBin}:/usr/bin:/bin`, "/bin/sh", "-c", command], { encoding: "utf-8" });
      expect(r.stderr, entry).not.toContain("No such file or directory");
    }
    expect(existsSync(path.join(backupDir, "cron.log"))).toBe(true);
    expect(readFileSync(dockerLog, "utf-8")).toContain("docker compose exec -T app find /tmp/project-forge");
    expect(readFileSync(dockerLog, "utf-8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("a custom FORGE_BACKUP_LOG gets its directory created; an unwritable log location is refused", () => {
    const c = newCron();
    const log = path.join(c.dir, "logs", "deep", "forge.log");
    expect(c.run({ FORGE_BACKUP_DIR: path.join(c.dir, "bk"), FORGE_BACKUP_LOG: log }).status).toBe(0);
    expect(existsSync(log)).toBe(true);
    const d = newCron();
    writeFileSync(path.join(d.dir, "blocker"), "file");
    const r = d.run({ FORGE_BACKUP_DIR: path.join(d.dir, "bk"), FORGE_BACKUP_LOG: path.join(d.dir, "blocker", "x.log") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The crontab was not changed");
    expect(d.content()).toBeNull();
  });

  it("a re-run with an unchanged block recreates a deleted backup directory and log, crontab only read", () => {
    const c = newCron();
    const backupDir = path.join(c.dir, "gone", "bk");
    expect(c.run({ FORGE_BACKUP_DIR: backupDir }).status).toBe(0);
    rmSync(path.join(c.dir, "gone"), { recursive: true, force: true });
    const writesBefore = c.calls().filter((a) => a !== "-l").length;
    const r = c.run({ FORGE_BACKUP_DIR: backupDir });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("already up to date");
    expect(existsSync(path.join(backupDir, "cron.log"))).toBe(true);
    expect(c.calls().filter((a) => a !== "-l")).toHaveLength(writesBefore);
  });

  it("--dry-run and --remove create no directory", () => {
    const c = newCron();
    const backupDir = path.join(c.dir, "never");
    c.run({ FORGE_BACKUP_DIR: backupDir }, ["--dry-run"]);
    c.run({ FORGE_BACKUP_DIR: backupDir }, ["--remove"]);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("FORGE_CRONTAB names another crontab program", () => {
    const c = newCron();
    const alt = path.join(c.dir, "alt-crontab");
    writeFileSync(alt, CRONTAB_STUB.replace("#!/bin/sh", '#!/bin/sh\necho alt >> "$STUB_CRONTAB_LOG"'));
    chmodSync(alt, 0o755);
    expect(c.run({ FORGE_BACKUP_DIR: BACKUP_DIR, FORGE_CRONTAB: alt }).status).toBe(0);
    expect(c.calls()[0]).toBe("alt");
  });
});
