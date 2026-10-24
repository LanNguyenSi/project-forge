import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(hc).toContain("/api/health");
  });

  it("pins DATABASE_URL to the forge_db volume mount", () => {
    expect(app).toMatch(/^ {6}DATABASE_URL: file:\/data\/project-forge\.db$/m);
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

describe("Makefile", () => {
  const recipe = (target: string) =>
    new RegExp(`^${target}:\\n((?:\\t.*\\n)+)`, "m").exec(read("Makefile"))?.[1] ?? "";

  it("rebuilds in both deploy and pull so a stale image is never started", () => {
    expect(recipe("deploy")).toContain("docker compose up -d --build");
    expect(recipe("pull")).toContain("docker compose up -d --build");
  });
});
