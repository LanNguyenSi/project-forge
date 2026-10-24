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
    expect(planforge).toContain("../agent-planforge");
  });

  it("gives the app a healthcheck against the health route", () => {
    const hc = /healthcheck:\n([\s\S]*?)\n    logging:/.exec(app)?.[1] ?? "";
    expect(hc).toContain("- CMD");
    expect(hc).toMatch(/^ {8}- "require\('http'\)\.get\('http:\/\/127\.0\.0\.1:3000\/api\/health'/m);
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
});

describe("docker-compose.override.example.yml", () => {
  it("does not set DATABASE_URL by default, so the compose default applies", () => {
    expect(read("docker-compose.override.example.yml")).not.toMatch(/^\s*DATABASE_URL:/m);
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
});
