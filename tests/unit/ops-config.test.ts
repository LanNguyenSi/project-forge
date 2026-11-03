// @vitest-environment node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf-8");

// Text-level checks (no YAML parser is a direct dependency). A service block
// runs from its two-space-indented name to the next service or top-level key.
function serviceBlock(file: string, name: string): string {
  const m = new RegExp(`^  ${name}:\\n((?:(?:    |\\s*#|\\s*\\n).*\\n?)*)`, "m").exec(read(file));
  return m?.[1] ?? "";
}

describe("docker-compose.yml defaults", () => {
  const app = serviceBlock("docker-compose.yml", "app");
  const planforge = serviceBlock("docker-compose.yml", "planforge");

  it("finds both service blocks", () => {
    expect(app).toContain("build: .");
    expect(planforge).toContain("dockerfile: server/Dockerfile");
  });

  // The planforge image is built from a pinned git revision, not from a
  // sibling checkout whose contents depend on the host.
  const contextLine = /^ {6}context: (.+)$/m.exec(planforge)?.[1] ?? "";
  const defaultContext = /^\$\{PLANFORGE_CONTEXT:-([^}]+)\}$/.exec(contextLine)?.[1] ?? "";

  it("builds planforge from a git URL pinned to a tag or a full commit SHA", () => {
    expect(defaultContext).toMatch(
      /^https:\/\/github\.com\/LanNguyenSi\/agent-planforge\.git#(v\d+\.\d+\.\d+|[0-9a-f]{40})$/,
    );
  });

  it("lets PLANFORGE_CONTEXT override the context, and only through that variable", () => {
    expect(contextLine).toMatch(/^\$\{PLANFORGE_CONTEXT:-[^}]+\}$/);
  });

  it("has no sibling-checkout path in the default compose outside comments", () => {
    const code = read("docker-compose.yml")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\.\.\/agent-planforge/);
    expect(code).not.toMatch(/context:\s*\.\.?\//);
  });

  it("keeps the planforge ref in exactly one place", () => {
    expect(read("docker-compose.yml").match(/agent-planforge\.git#/g)).toHaveLength(1);
  });

  it("gives the app a healthcheck against the health route", () => {
    const hc = /healthcheck:\n([\s\S]*?)\n    logging:/.exec(app)?.[1] ?? "";
    expect(hc).toContain("- CMD");
    expect(hc).toMatch(/^ {8}- "require\('http'\)\.get\('http:\/\/127\.0\.0\.1:3000\/api\/health'/m);
  });

  // Named volumes are prefixed with the project name; without the pin the
  // forge_db volume would follow the checkout directory (docs/deployment.md,
  // "Database location"). The name is the one the production volume already has.
  it("pins the compose project name at the top level, so forge_db does not follow the checkout directory", () => {
    expect(read("docker-compose.yml")).toMatch(/^name: project-forge$/m);
  });

  it("probes every 2 s during the start period (start_interval), after the 60 s start_period", () => {
    const hc = /healthcheck:\n([\s\S]*?)\n    logging:/.exec(app)?.[1] ?? "";
    expect(hc).toMatch(/^ {6}start_period: 60s$/m);
    expect(hc).toMatch(/^ {6}start_interval: 2s$/m);
  });

  it("defaults DATABASE_URL to the forge_db volume mount, overridable only through FORGE_DATABASE_URL", () => {
    expect(app).toMatch(
      /^ {6}DATABASE_URL: \$\{FORGE_DATABASE_URL:-file:\/data\/project-forge\.db\}$/m,
    );
    expect(app).toMatch(/^ {6}- forge_db:\/data$/m);
  });

  it("requires PLANFORGE_SERVICE_TOKEN for both services", () => {
    const required = /^ {6}PLANFORGE_SERVICE_TOKEN: \$\{PLANFORGE_SERVICE_TOKEN:\?[^}]+\}$/m;
    expect(app).toMatch(required);
    expect(planforge).toMatch(required);
  });

  it("bounds the json-file logs of both services through the shared anchor", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/^x-logging: &default-logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "\d+m"\n {4}max-file: "\d+"$/m);
    expect(app).toMatch(/^ {4}logging: \*default-logging$/m);
    expect(planforge).toMatch(/^ {4}logging: \*default-logging$/m);
  });

  // The app runs as root (the production forge_db volume is root-owned) but is
  // hardened so it keeps none of the privileges root does not need. Pinned by
  // text, like the rest of this file (no YAML parser is a direct dependency).
  it("runs the app with no-new-privileges, so no process gains privileges after start", () => {
    expect(app).toMatch(/^ {4}security_opt:\n {6}- no-new-privileges:true$/m);
  });

  it("drops every Linux capability from the app", () => {
    expect(app).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m);
  });

  it("adds no capability back to the app, because root needs none of the dropped set", () => {
    expect(app).not.toMatch(/^ {4}cap_add:/m);
  });

  // planforge builds from an external image whose runtime needs (scaffoldkit,
  // tar packing as root) cannot be verified from this repo, so it is left
  // unchanged on purpose.
  it("leaves planforge without the hardening keys, so the change is scoped to the app", () => {
    expect(planforge).not.toMatch(/^ {4}(security_opt|cap_drop|cap_add):/m);
  });
});

describe("docker-compose.override.example.yml name", () => {
  it("does not set a top-level name, so the override joins the pinned project of docker-compose.yml", () => {
    expect(read("docker-compose.override.example.yml")).not.toMatch(/^name:/m);
  });
});

describe(".github/workflows/ci.yml docker-build job", () => {
  // Text-level, like the compose checks: the job block runs from its name to
  // the next top-level job key or the end of the file.
  const job =
    /^ {2}docker-build:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/m.exec(read(".github/workflows/ci.yml"))?.[1] ?? "";
  // The smoke step alone: from its name to the end of the job block.
  const smoke = /- name: Image starts and answers \/api\/health\n([\s\S]*)$/.exec(job)?.[1] ?? "";

  it("captures the job and the smoke step, and stops at the job boundary", () => {
    expect(job).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(job).not.toMatch(/^ {2}build:/m);
    expect(smoke).toMatch(/^ {8}run: \|$/m);
  });

  it("bounds the whole job with timeout-minutes", () => {
    expect(job).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  it("finds the job and builds the image from one IMAGE variable", () => {
    expect(job).toMatch(/^ {6}IMAGE: project-forge:ci$/m);
    expect(job).toMatch(/docker build -t "\$IMAGE" \./);
  });

  it("starts the image detached and polls /api/health", () => {
    expect(job).toMatch(/Image starts and answers \/api\/health/);
    expect(job).toMatch(/docker run -d/);
    expect(job).toMatch(/\/api\/health/);
  });

  it("generates the secret in the job and sets a non-placeholder NEXTAUTH_URL", () => {
    expect(job).toMatch(/NEXTAUTH_SECRET="\$\(openssl rand -hex 32\)"/);
    expect(job).toMatch(/NEXTAUTH_URL=https:\/\/(?!your-forge\.example\.com)\S+/);
  });

  it("keeps its SQLite file on a tmpfs at the path of DATABASE_URL, so the run leaves nothing behind", () => {
    expect(smoke).toMatch(/^ {12}--tmpfs \/data \\$/m);
    expect(smoke).toMatch(/-e DATABASE_URL=file:\/data\/project-forge\.db \\$/m);
  });

  it("polls against a 90 s deadline, not a fixed number of attempts", () => {
    expect(smoke).toMatch(/^ {10}deadline=\$\(\(SECONDS \+ 90\)\)$/m);
    expect(smoke).toMatch(/^ {10}while \[ "\$SECONDS" -lt "\$deadline" \]; do$/m);
    expect(smoke).not.toMatch(/-lt 90/);
  });

  it("retries only while nothing listens (000) and gives up once the container is not running", () => {
    expect(smoke).toMatch(/^ {12}\[ "\$code" != 000 \] && break$/m);
    expect(smoke).toMatch(
      /^ {12}\[ "\$\(docker inspect -f '\{\{\.State\.Running\}\}' "\$cid"\)" = true \] \|\| break$/m,
    );
  });

  it("also fails when the status is 200 but the body is not {\"ok\":true}", () => {
    expect(smoke).toMatch(/\|\| \[ "\$\(cat "\$body"\)" != '\{"ok":true\}' \]; then$/m);
  });

  it("fails on a non-200 answer, prints the container logs and always removes the container", () => {
    expect(job).toMatch(/"\$code" != 200/);
    expect(job).toMatch(/docker logs "\$cid"/);
    expect(job).toMatch(/trap cleanup EXIT/);
    expect(job).toMatch(/docker rm -f "\$cid"/);
  });
});

describe("docker-compose.override.example.yml", () => {
  it("does not set DATABASE_URL by default, so the compose default applies", () => {
    expect(read("docker-compose.override.example.yml")).not.toMatch(/^\s*DATABASE_URL:/m);
  });

  it("ships the NEXTAUTH_URL placeholder, not a live URL", () => {
    expect(read("docker-compose.override.example.yml")).toMatch(
      /^\s*NEXTAUTH_URL: "https:\/\/your-forge\.example\.com"$/m,
    );
  });
});

describe(".env.example", () => {
  const lines = read(".env.example").split("\n");

  it("keeps the local development DATABASE_URL active", () => {
    expect(lines).toContain("DATABASE_URL=file:./db/project-forge.db");
  });

  it("documents FORGE_DATABASE_URL only as a commented-out example, so the volume default applies", () => {
    expect(lines.some((l) => l.startsWith("FORGE_DATABASE_URL="))).toBe(false);
    expect(lines).toContain("# FORGE_DATABASE_URL=file:/data/project-forge.db");
  });
});

describe("app healthcheck script", () => {
  // The probe is the inline `node -e` string of docker-compose.yml, run here
  // against a local server with the port swapped in. Pins the exit-code
  // contract: 0 only for a 200 answer, 1 for any other status and for a
  // refused connection.
  const script = /^ {8}- "(require\('http'\)\.get\('http:\/\/127\.0\.0\.1:3000\/api\/health'.*)"$/m.exec(
    serviceBlock("docker-compose.yml", "app"),
  )?.[1];

  function probe(port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        ["-e", (script ?? "").replace("127.0.0.1:3000", `127.0.0.1:${port}`)],
        { timeout: 10_000, killSignal: "SIGKILL" },
        (err) => resolve(err ? ((err as { code?: number | string }).code === 1 ? 1 : null) : 0),
      );
      child.stdin?.end();
    });
  }

  let server: Server;
  let status = 200;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server.listening) await new Promise<void>((r) => server.close(() => r()));
  });

  it("extracts the script from the compose file", () => {
    expect(script).toContain("r.statusCode === 200");
  });

  it("exits 0 when /api/health answers 200", async () => {
    status = 200;
    expect(await probe(port)).toBe(0);
  });

  it("exits 1 when /api/health answers 500", async () => {
    status = 500;
    expect(await probe(port)).toBe(1);
  });

  it("exits 1 when the connection is refused", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probe(port)).toBe(1);
  });
});

describe("Makefile", () => {
  const recipe = (target: string) =>
    new RegExp(`^${target}:\\n((?:\\t.*\\n)+)`, "m").exec(read("Makefile"))?.[1] ?? "";

  it("rebuilds in both deploy and pull so a stale image is never started", () => {
    expect(recipe("deploy")).toContain("docker compose up -d --build");
    expect(recipe("pull")).toContain("docker compose up -d --build");
  });

  it("install-cron runs scripts/install-cron.sh (extra arguments via ARGS) and is phony", () => {
    expect(recipe("install-cron")).toContain("sh scripts/install-cron.sh $(ARGS)");
    expect(/^\.PHONY:.*\binstall-cron\b/m.test(read("Makefile"))).toBe(true);
  });
});

describe("docs/deployment.md restore procedure", () => {
  const doc = read("docs/deployment.md");
  const section = doc.slice(
    doc.indexOf("### Restoring a backup"),
    doc.indexOf("## Upgrading to committed migrations"),
  );

  it("does not copy a host file into the volume with compose cp (the copy keeps the host uid)", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/docker compose cp [^\n`]* app:/);
    expect(section).toMatch(/cat > \/data\/project-forge\.db\.restore/);
  });

  it("refuses an empty or foreign restore file before it replaces the live database", () => {
    expect(section).toMatch(/\[ -s \/data\/project-forge\.db\.restore \]/);
    expect(section).toMatch(/SELECT count\(\*\) > 0 FROM _prisma_migrations/);
  });

  it("proves the restored database is writable before calling it healthy", () => {
    expect(section).toMatch(/CREATE TABLE _write_check/);
  });
});
