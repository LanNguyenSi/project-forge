// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Runs the production build (`next start`) on a loopback port and sends
 * chunked bodies over a real socket. The in-process tests in
 * v1-truncated-body.test.ts only simulate what Next's middleware body clone
 * does at experimental.middlewareClientMaxBodySize; this one observes it:
 * without the route's cloneLimitBytes option a chunked body above the clone
 * limit fails as malformed JSON and answers 500.
 *
 * It needs `npm run build` first (CI builds before the tests) and skips with
 * a reason when .next/BUILD_ID is absent. The server runs in its own process
 * group, which a hard timer and afterAll both kill. It runs with a throwaway
 * SQLite file, dummy secrets and no PLANFORGE_URL, so a body that gets past
 * the size checks ends in a 500 from the missing planforge config and never
 * calls out.
 *
 * Runs in the default vitest project: it spawns an external process, so it
 * adds nothing to the coverage numbers and needs no separate config.
 */

const ROOT = path.join(__dirname, "..", "..");
const BUILT = existsSync(path.join(ROOT, ".next", "BUILD_ID"));
const SECRET = "real-server-test-secret-0123456789abcdef";
const TOKEN = "pf_realservertoken0123456789abcdefgh";
const HARD_TIMEOUT_MS = 120_000;
// The bytes the route reads at most: 601_712 (route cap) and 602_736 (clone limit).
const ROUTE_CAP = 601_712;

let tmpDir = "";
let child: ChildProcess | undefined;
let killTimer: NodeJS.Timeout | undefined;
let port = 0;
const serverLog: string[] = [];

function killGroup(): void {
  if (killTimer) clearTimeout(killTimer);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(p));
    });
  });
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`server exited early:\n${serverLog.join("")}`);
    try {
      // The middleware answers 401 without a key; any answer means it serves.
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
      if (res.status === 401) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not ready:\n${serverLog.join("")}`);
}

beforeAll(async () => {
  if (!BUILT) return;
  tmpDir = mkdtempSync(path.join(tmpdir(), "pf-real-server-"));
  const dbUrl = `file:${path.join(tmpDir, "forge.db")}`;
  // Same schema source as the container: the committed migrations.
  execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const user = await db.user.create({ data: { id: "rs-user", email: "rs@test.com" } });
    await db.apiToken.create({
      data: {
        id: "rs-token",
        // Keyed hash as hashApiToken() in lib/db.ts computes it.
        tokenHash: createHmac("sha256", SECRET).update(TOKEN).digest("hex"),
        tokenPrefix: TOKEN.slice(0, 10),
        name: "real-server",
        userId: user.id,
      },
    });
  } finally {
    await db.$disconnect();
  }

  port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    DATABASE_URL: dbUrl,
    NEXTAUTH_SECRET: SECRET,
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    GITHUB_PAT_ENCRYPTION_KEY: "real-server-test-pat-key-0123456789abcdef",
    FORGE_TEMP_DIR: path.join(tmpDir, "sessions"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  child = spawn(
    path.join(ROOT, "node_modules", ".bin", "next"),
    ["start", "-H", "127.0.0.1", "-p", String(port)],
    { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (d) => serverLog.push(String(d)));
  child.stderr?.on("data", (d) => serverLog.push(String(d)));
  killTimer = setTimeout(killGroup, HARD_TIMEOUT_MS);
  killTimer.unref();
  await waitReady();
}, 90_000);

afterAll(() => {
  killGroup();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** JSON object of exactly `size` bytes. */
function jsonBody(size: number): Buffer {
  const pre = '{"projectName":"x","summary":"';
  const suf = '"}';
  return Buffer.from(pre + "a".repeat(size - pre.length - suf.length) + suf);
}

/** Send `body` with Transfer-Encoding: chunked, `writeSize` bytes per write. */
function sendChunked(
  urlPath: string,
  body: Buffer,
  writeSize: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "x-api-key": TOKEN,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    for (let i = 0; i < body.length; i += writeSize) req.write(body.subarray(i, i + writeSize));
    req.end();
  });
}

describe.skipIf(!BUILT)("chunked /api/v1 bodies against a real `next start`", () => {
  const routes = ["/api/v1/generate", "/api/v1/projects"];

  describe.each(routes)("POST %s", (urlPath) => {
    it("a valid chunked body just under the route cap is not rejected as too large", async () => {
      const res = await sendChunked(urlPath, jsonBody(ROUTE_CAP - 1), 64 * 1024);
      // It got past auth and the size checks: generate ends in a 500 from the
      // unset planforge URL, projects in a 400 for the missing GitHub PAT.
      expect([400, 500]).toContain(res.status);
      expect(res.text).not.toContain("Unterminated");
    });

    it.each([
      ["64 KiB", 64 * 1024],
      ["1 MiB", 1024 * 1024],
    ])("a chunked 700_000 byte body written in %s pieces answers 413", async (_label, writeSize) => {
      const res = await sendChunked(urlPath, jsonBody(700_000), writeSize);
      expect(res.status).toBe(413);
    });

    it("a body declaring an oversize Content-Length answers 413", async () => {
      const body = jsonBody(700_000);
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method: "POST",
        headers: { "x-api-key": TOKEN, "content-type": "application/json" },
        body: new Uint8Array(body),
      });
      expect(res.status).toBe(413);
    });
  });
});

if (!BUILT) {
  // Stated reason for the skip above: there is no production build to run.
  describe("chunked /api/v1 bodies against a real `next start`", () => {
    it.skip("skipped: .next/BUILD_ID is absent, run `npm run build` first", () => {});
  });
}
