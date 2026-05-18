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
import { runPlanforgeViaHttp, PlanforgeClientError, assertScaffoldkitRan } from "../../lib/planforge-client";

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

  it("surfaces scaffoldkit metadata from the done event to callers", async () => {
    const tarGz = await buildFixtureTarGzB64();
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        {
          event: "done",
          data: {
            requestId: "req-sk",
            planOutput: {},
            scaffoldkitInput: { blueprint: "none" },
            outputTarGz: tarGz,
            scaffoldkit: { invoked: true, exitCode: 0, stderr: "" },
            exitCode: 0,
          },
        },
      ]),
    ) as unknown as typeof fetch;

    const result = await runPlanforgeViaHttp({
      baseUrl: "http://planforge:8223",
      token: "t",
      input: {},
      outdir,
    });

    expect(result.scaffoldkit).toEqual({ invoked: true, exitCode: 0, stderr: "" });
  });

  it("sends `scaffold: true` explicitly on the request body", async () => {
    const tarGz = await buildFixtureTarGzB64();
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          event: "done",
          data: {
            requestId: "req-explicit",
            planOutput: {},
            scaffoldkitInput: null,
            outputTarGz: tarGz,
            scaffoldkit: { invoked: false, skipped: "no_input" },
            exitCode: 0,
          },
        },
      ]),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await runPlanforgeViaHttp({
      baseUrl: "http://planforge:8223",
      token: "t",
      input: { projectName: "X" },
      outdir,
    });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.scaffold).toBe(true);
    expect(sentBody.input).toEqual({ projectName: "X" });
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

describe("assertScaffoldkitRan", () => {
  it("passes when scaffoldkit ran cleanly", () => {
    expect(() =>
      assertScaffoldkitRan({
        requestId: "r",
        planOutput: {},
        scaffoldkitInput: {},
        scaffoldkit: { invoked: true, exitCode: 0, stderr: "" },
      }),
    ).not.toThrow();
  });

  it("throws loudly when scaffoldkit was skipped with not_installed", () => {
    // This is the critical failure mode: planforge container misconfigured
    // (no SCAFFOLDKIT_PYTHON venv). Without this guard, /api/v1/projects
    // would push a planning-only repo to the user's GitHub silently.
    expect(() =>
      assertScaffoldkitRan({
        requestId: "r",
        planOutput: {},
        scaffoldkitInput: null,
        scaffoldkit: { invoked: false, skipped: "not_installed" },
      }),
    ).toThrow(/not_installed/);
  });

  it("throws when scaffoldkit ran but exited nonzero", () => {
    expect(() =>
      assertScaffoldkitRan({
        requestId: "r",
        planOutput: {},
        scaffoldkitInput: {},
        scaffoldkit: { invoked: true, exitCode: 7, stderr: "boom" },
      }),
    ).toThrow(/exited 7/);
  });

  it("surfaces the underlying parser error when skipped is input_unreadable", () => {
    // The input_unreadable branch (added in agent-planforge PR #71)
    // indicates a CLI bug, not a normal skip. The thrown error must
    // carry the parser's message so operators can act on it without
    // re-running the request.
    expect(() =>
      assertScaffoldkitRan({
        requestId: "r",
        planOutput: {},
        scaffoldkitInput: null,
        scaffoldkit: {
          invoked: false,
          skipped: "input_unreadable",
          inputReadError: "Unexpected token { in JSON at position 12",
        },
      }),
    ).toThrow(/input_unreadable.*Unexpected token/);
  });

  it("is tolerant when the service predates the scaffoldkit-metadata contract", () => {
    // Old planforge deploys don't emit the `scaffoldkit` field at all.
    // Don't block project-forge until the whole fleet is upgraded.
    expect(() =>
      assertScaffoldkitRan({
        requestId: "r",
        planOutput: {},
        scaffoldkitInput: {},
      }),
    ).not.toThrow();
  });
});
