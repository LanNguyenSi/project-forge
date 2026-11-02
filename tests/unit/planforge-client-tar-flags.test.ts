/**
 * Pins the tar flags the scaffold extraction uses. The app container drops
 * every capability, so extraction must not try to restore the packer's
 * ownership (that needs CHOWN).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const spawned = vi.hoisted(() => [] as unknown[][]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: unknown[]) => {
    spawned.push(args);
    return (actual.spawn as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.spawn;
  return { ...actual, default: { ...actual, spawn }, spawn };
});

import { runPlanforgeViaHttp } from "../../lib/planforge-client";

const execFileP = promisify(execFile);

describe("scaffold tar extraction", () => {
  it("runs tar with --no-same-owner and still extracts the files", async () => {
    const src = await mkdtemp(resolve(tmpdir(), "tar-flags-src-"));
    const outdir = await mkdtemp(resolve(tmpdir(), "tar-flags-out-"));
    const realFetch = global.fetch;
    try {
      await writeFile(resolve(src, "a.txt"), "hello");
      await mkdir(resolve(src, "d"));
      const { stdout } = await execFileP("tar", ["-czf", "-", "-C", src, "."], {
        encoding: "buffer",
      });
      const body =
        `event: done\ndata: ${JSON.stringify({
          requestId: "r",
          planOutput: {},
          scaffoldkitInput: {},
          outputTarGz: stdout.toString("base64"),
          exitCode: 0,
        })}\n\n`;
      global.fetch = vi.fn().mockResolvedValue(
        new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ) as unknown as typeof fetch;

      await runPlanforgeViaHttp({
        baseUrl: "http://planforge:8223",
        token: "t",
        input: { projectName: "T" },
        outdir,
      });

      const call = spawned.find((c) => c[0] === "tar");
      expect(call).toBeDefined();
      expect(call![1] as string[]).toContain("--no-same-owner");
      expect(await readFile(resolve(outdir, "a.txt"), "utf8")).toBe("hello");
    } finally {
      global.fetch = realFetch;
      await rm(src, { recursive: true, force: true });
      await rm(outdir, { recursive: true, force: true });
    }
  });
});
