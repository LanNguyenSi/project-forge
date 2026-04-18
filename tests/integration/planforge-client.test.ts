/**
 * Unit test for `lib/planforge-client.ts`. Verifies:
 *   - SSE frames are unfolded correctly, `progress` hooks fire in order.
 *   - `done` event's `outputTarGz` is base64-decoded + extracted via
 *     system `tar`, reproducing the expected file layout.
 *   - `error` events abort with a PlanforgeClientError carrying the
 *     message.
 *   - HTTP-level failures (non-2xx, empty body) fail loudly.
 *
 * No live service required — the fetch is mocked and the tarball is
 * constructed on the fly from a known temp tree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runPlanforgeViaHttp, PlanforgeClientError } from "../../lib/planforge-client";

const execFileP = promisify(execFile);

async function buildFixtureTarGzB64(): Promise<string> {
  const src = await mkdtemp(resolve(tmpdir(), "client-fixture-src-"));
  try {
    await mkdir(resolve(src, "planning"), { recursive: true });
    await mkdir(resolve(src, "exports"), { recursive: true });
    await writeFile(resolve(src, "planforge-index.json"), JSON.stringify({ generatedBy: "agent-planforge" }));
    await writeFile(resolve(src, "planning", "plan-output.json"), JSON.stringify({ projectName: "Test" }));
    await writeFile(resolve(src, "exports", "scaffoldkit-input.json"), JSON.stringify({ blueprint: "none" }));
    const { stdout } = await execFileP("tar", ["-czf", "-", "-C", src, "."], { encoding: "buffer" });
    return stdout.toString("base64");
  } finally {
    await rm(src, { recursive: true, force: true });
  }
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  // Stream it in chunks so the frame reassembler actually gets exercised.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = body.match(/[\s\S]{1,40}/g) ?? [body];
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("runPlanforgeViaHttp", () => {
  let outdir: string;
  const realFetch = global.fetch;

  beforeEach(async () => {
    outdir = await mkdtemp(resolve(tmpdir(), "planforge-client-out-"));
  });
  afterEach(async () => {
    await rm(outdir, { recursive: true, force: true });
    global.fetch = realFetch;
  });

  it("extracts the tarball and returns structured done data", async () => {
    const tarGz = await buildFixtureTarGzB64();
    const progress: string[] = [];
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { event: "progress", data: { line: "Generated planning artifacts", stream: "stdout" } },
        {
          event: "done",
          data: {
            requestId: "req-1",
            planOutput: { projectName: "Test" },
            scaffoldkitInput: { blueprint: "none" },
            outputTarGz: tarGz,
            exitCode: 0,
          },
        },
      ]),
    ) as unknown as typeof fetch;

    const result = await runPlanforgeViaHttp({
      baseUrl: "http://planforge:8223",
      token: "t",
      input: { projectName: "Test" },
      outdir,
      onProgress: (line) => progress.push(line),
    });

    expect(result.requestId).toBe("req-1");
    expect(result.planOutput).toEqual({ projectName: "Test" });
    expect(progress).toEqual(["Generated planning artifacts"]);

    // Verify the CLI's file layout appears on disk.
    const planforgeIndex = JSON.parse(
      await readFile(resolve(outdir, "planforge-index.json"), "utf8"),
    );
    expect(planforgeIndex.generatedBy).toBe("agent-planforge");
    const planOutput = JSON.parse(
      await readFile(resolve(outdir, "planning", "plan-output.json"), "utf8"),
    );
    expect(planOutput.projectName).toBe("Test");
    const skInput = JSON.parse(
      await readFile(resolve(outdir, "exports", "scaffoldkit-input.json"), "utf8"),
    );
    expect(skInput.blueprint).toBe("none");
  });

  it("throws PlanforgeClientError on an `error` SSE frame", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { event: "error", data: { message: "planforge CLI crashed", exitCode: 2 } },
      ]),
    ) as unknown as typeof fetch;

    await expect(
      runPlanforgeViaHttp({
        baseUrl: "http://planforge:8223",
        token: "t",
        input: {},
        outdir,
      }),
    ).rejects.toThrow(/planforge CLI crashed/);
  });

  it("throws when the HTTP response is non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(
      runPlanforgeViaHttp({
        baseUrl: "http://planforge:8223",
        token: "bad",
        input: {},
        outdir,
      }),
    ).rejects.toThrow(PlanforgeClientError);
  });

  it("throws when the stream ends without a done event", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { event: "progress", data: { line: "hello", stream: "stdout" } },
      ]),
    ) as unknown as typeof fetch;

    await expect(
      runPlanforgeViaHttp({
        baseUrl: "http://planforge:8223",
        token: "t",
        input: {},
        outdir,
      }),
    ).rejects.toThrow(/done event/);
  });

  it("throws when done arrives without outputTarGz (service predates tarball contract)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        {
          event: "done",
          data: { requestId: "req-2", planOutput: {}, scaffoldkitInput: null, exitCode: 0 },
        },
      ]),
    ) as unknown as typeof fetch;

    await expect(
      runPlanforgeViaHttp({
        baseUrl: "http://planforge:8223",
        token: "t",
        input: {},
        outdir,
      }),
    ).rejects.toThrow(/outputTarGz/);
  });
});
