// @vitest-environment node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf-8");

// js-yaml is not a direct dependency (it is pinned through `overrides` and
// arrives transitively through swagger-ui-react) and ships no types here, so it
// is loaded with a minimal local signature.
const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };

type Obj = Record<string, unknown>;

// Compose files are parsed, so key order, quoting, comments and the
// `KEY: value` / `- KEY=value` forms of `environment` do not matter.
function loadCompose(file: string): Obj {
  return load(read(file)) as Obj;
}

function service(compose: Obj, name: string): Obj {
  const services = compose.services as Obj | undefined;
  return (services?.[name] ?? {}) as Obj;
}

// `environment` is either a map or a list of `KEY=value` / `KEY` entries.
function env(svc: Obj): Record<string, string | null> {
  const e = svc.environment;
  if (Array.isArray(e)) {
    return Object.fromEntries(
      e.map((entry) => {
        const s = String(entry);
        const i = s.indexOf("=");
        return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries((e ?? {}) as Obj).map(([k, v]) => [k, v === null ? null : String(v)]),
  );
}

// Every string scalar in the parsed document (keys excluded). Comments never
// show up here.
function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === "object") return Object.values(node).flatMap(strings);
  return [];
}

function buildOf(svc: Obj): Obj {
  const b = svc.build;
  return typeof b === "string" ? { context: b } : ((b ?? {}) as Obj);
}

const composeFile = "docker-compose.yml";

describe("docker-compose.yml defaults", () => {
  const compose = loadCompose(composeFile);
  const app = service(compose, "app");
  const planforge = service(compose, "planforge");

  it("finds both service blocks", () => {
    expect(buildOf(app).context).toBe(".");
    expect(buildOf(planforge).dockerfile).toBe("server/Dockerfile");
  });

  // The planforge image is built from a pinned git revision, not from a
  // sibling checkout whose contents depend on the host.
  const contextValue = String(buildOf(planforge).context ?? "");
  const defaultContext = /^\$\{PLANFORGE_CONTEXT:-([^}]+)\}$/.exec(contextValue)?.[1] ?? "";

  it("builds planforge from a git URL pinned to a tag or a full commit SHA", () => {
    expect(defaultContext).toMatch(
      /^https:\/\/github\.com\/LanNguyenSi\/agent-planforge\.git#(v\d+\.\d+\.\d+|[0-9a-f]{40})$/,
    );
  });

  it("lets PLANFORGE_CONTEXT override the context, and only through that variable", () => {
    expect(contextValue).toMatch(/^\$\{PLANFORGE_CONTEXT:-[^}]+\}$/);
  });

  it("has no sibling-checkout path in the default compose outside comments", () => {
    const values = strings(compose);
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((v) => /\.\.\/agent-planforge/.test(v))).toEqual([]);
    expect(values.filter((v) => /^\.\.?\//.test(v))).toEqual([]);
  });

  it("keeps the planforge ref in exactly one place", () => {
    expect(strings(compose).filter((v) => v.includes("agent-planforge.git#"))).toHaveLength(1);
  });

  it("gives the app a healthcheck against the health route", () => {
    const test = (app.healthcheck as Obj | undefined)?.test;
    expect(Array.isArray(test)).toBe(true);
    const parts = test as string[];
    expect(parts[0]).toBe("CMD");
    expect(parts[parts.length - 1]).toMatch(
      /^require\('http'\)\.get\('http:\/\/127\.0\.0\.1:3000\/api\/health'/,
    );
  });

  // Named volumes are prefixed with the project name; without the pin the
  // forge_db volume would follow the checkout directory (docs/deployment.md,
  // "Database location"). The name is the one the production volume already has.
  it("pins the compose project name at the top level, so forge_db does not follow the checkout directory", () => {
    expect(compose.name).toBe("project-forge");
  });

  it("probes every 2 s during the start period (start_interval), after the 60 s start_period", () => {
    const hc = app.healthcheck as Obj;
    expect(hc.start_period).toBe("60s");
    expect(hc.start_interval).toBe("2s");
  });

  it("defaults DATABASE_URL to the forge_db volume mount, overridable only through FORGE_DATABASE_URL", () => {
    expect(env(app).DATABASE_URL).toBe("${FORGE_DATABASE_URL:-file:/data/project-forge.db}");
    expect(app.volumes).toContain("forge_db:/data");
  });

  // Same pattern as DATABASE_URL: deploy tooling that runs
  // `docker compose -f docker-compose.yml` skips the override, so a
  // non-default planforge URL must come from FORGE_PLANFORGE_URL (.env or
  // the shell), never from the override and never from PLANFORGE_URL itself
  // (.env may carry http://localhost:8223 for local development, and that
  // must not reach the container).
  it("defaults PLANFORGE_URL to the planforge service, overridable only through FORGE_PLANFORGE_URL", () => {
    expect(env(app).PLANFORGE_URL).toBe("${FORGE_PLANFORGE_URL:-http://planforge:8223}");
    expect(JSON.stringify(app)).not.toMatch(/\$\{PLANFORGE_URL\b/);
  });

  it("requires PLANFORGE_SERVICE_TOKEN for both services", () => {
    const required = /^\$\{PLANFORGE_SERVICE_TOKEN:\?[^}]+\}$/;
    expect(env(app).PLANFORGE_SERVICE_TOKEN).toMatch(required);
    expect(env(planforge).PLANFORGE_SERVICE_TOKEN).toMatch(required);
  });

  it("bounds the json-file logs of both services through the shared anchor", () => {
    const shared = compose["x-logging"] as Obj;
    expect(shared.driver).toBe("json-file");
    const options = shared.options as Obj;
    expect(String(options["max-size"])).toMatch(/^\d+m$/);
    expect(String(options["max-file"])).toMatch(/^\d+$/);
    // An alias resolves to the very same object as the anchor.
    expect(app.logging).toBe(shared);
    expect(planforge.logging).toBe(shared);
  });

  // The app runs as root (the production forge_db volume is root-owned) but is
  // hardened so it keeps none of the privileges root does not need.
  it("runs the app with no-new-privileges, so no process gains privileges after start", () => {
    expect(app.security_opt).toEqual(["no-new-privileges:true"]);
  });

  it("drops every Linux capability from the app", () => {
    expect(app.cap_drop).toEqual(["ALL"]);
  });

  it("adds no capability back to the app, because root needs none of the dropped set", () => {
    expect(app).not.toHaveProperty("cap_add");
  });

  // planforge builds from an external image whose runtime needs (scaffoldkit,
  // tar packing as root) cannot be verified from this repo, so it is left
  // unchanged on purpose.
  it("leaves planforge without the hardening keys, so the change is scoped to the app", () => {
    for (const key of ["security_opt", "cap_drop", "cap_add"]) {
      expect(planforge).not.toHaveProperty(key);
    }
  });
});

describe("docker-compose.override.example.yml name", () => {
  it("does not set a top-level name, so the override joins the pinned project of docker-compose.yml", () => {
    expect(loadCompose("docker-compose.override.example.yml")).not.toHaveProperty("name");
  });
});

describe(".github/workflows/ci.yml docker-build job", () => {
  // Text-level (the compose checks above parse YAML): the job block runs from its name to
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
  const overrideEnv = env(service(loadCompose("docker-compose.override.example.yml"), "app"));

  it("does not set DATABASE_URL by default, so the compose default applies", () => {
    expect(overrideEnv).not.toHaveProperty("DATABASE_URL");
  });

  it("ships the NEXTAUTH_URL placeholder, not a live URL", () => {
    expect(overrideEnv.NEXTAUTH_URL).toBe("https://your-forge.example.com");
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

  it("documents FORGE_PLANFORGE_URL only as a commented-out example, so the compose default applies", () => {
    expect(lines.some((l) => l.startsWith("FORGE_PLANFORGE_URL="))).toBe(false);
    expect(lines).toContain("# FORGE_PLANFORGE_URL=http://planforge:8223");
  });
});

describe("app healthcheck script", () => {
  // The probe is the inline `node -e` string of docker-compose.yml, run here
  // against a local server with the port swapped in. Pins the exit-code
  // contract: 0 only for a 200 answer, 1 for any other status and for a
  // refused connection.
  const hcTest = (service(loadCompose(composeFile), "app").healthcheck as Obj | undefined)?.test;
  const script = Array.isArray(hcTest)
    ? (hcTest as string[]).find((p) => p.startsWith("require('http').get('http://127.0.0.1:3000/api/health'"))
    : undefined;

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
