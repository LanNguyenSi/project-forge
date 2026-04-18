/**
 * HTTP client for the agent-planforge service.
 *
 * Replaces the `child_process.spawn("node", [bootstrap-plan.js, ...])` path
 * in `lib/planforge-runner.ts` with a `POST /api/generate` call against the
 * deployed planforge container. Part of the ADR-0002 decoupling — see
 * `docs/adrs/0002-tool-decoupling-service-boundary.md`.
 *
 * Shape of the exchange:
 *   1. POST the planforge input JSON to `${PLANFORGE_URL}/api/generate` with
 *      a Bearer `PLANFORGE_SERVICE_TOKEN`.
 *   2. Server streams SSE events — `progress` lines forwarded as-is to the
 *      caller's optional `onProgress` hook so logs keep their existing
 *      shape, plus a final `done` event carrying `outputTarGz` (base64
 *      gzipped tarball of the CLI's output dir contents).
 *   3. Client untars `outputTarGz` into the caller-supplied `outdir`. The
 *      tar packs directory *contents* (server does `tar -C <dir> .`), so
 *      extracting straight into `outdir` reproduces the layout the CLI
 *      would have written there itself — no nested `out/` folder.
 *   4. Downstream code (`resolvePlanforgeOutputPaths`, scaffoldkit
 *      shell-out, post-scaffold review, preview read) keeps reading from
 *      `outdir` exactly as before.
 *
 * Keeps the scaffoldkit subprocess in `app/api/v1/generate/route.ts`
 * untouched for this ticket. Moving scaffoldkit into planforge is a
 * separate follow-up — sunset window stays open.
 */
import { spawn } from "node:child_process";

export interface RunPlanforgeOptions {
  /** Base URL of the planforge service, e.g. `http://planforge:8223`. */
  baseUrl: string;
  /** Shared service token (PLANFORGE_SERVICE_TOKEN). */
  token: string;
  /** The planforge input payload — same shape the CLI's `--input` accepts. */
  input: unknown;
  /** Local directory to extract the CLI output into. Must already exist. */
  outdir: string;
  /**
   * Optional stream sink for SSE `progress` lines. The string passed is the
   * raw stdout/stderr line the CLI wrote — matches the old subprocess-stdout
   * contract so existing progress UIs don't have to change.
   */
  onProgress?: (line: string, stream: "stdout" | "stderr") => void;
  /** Request timeout in ms. The whole POST + SSE + untar cycle. */
  timeoutMs?: number;
}

export interface PlanforgeRunResult {
  requestId: string;
  planOutput: unknown;
  scaffoldkitInput: unknown | null;
}

export class PlanforgeClientError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "PlanforgeClientError";
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runPlanforgeViaHttp(
  options: RunPlanforgeOptions,
): Promise<PlanforgeRunResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("planforge HTTP call timed out")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${options.baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ input: options.input }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Body may carry a JSON error message; try but tolerate plain text.
      const body = await res.text().catch(() => "");
      throw new PlanforgeClientError(
        `planforge service returned ${res.status}: ${body.slice(0, 500)}`,
        res.status,
      );
    }
    if (!res.body) {
      throw new PlanforgeClientError("planforge service returned an empty body");
    }

    // SSE is a sequence of `event:` + `data:` blocks separated by blank
    // lines. No off-the-shelf parser — the service writes simple frames
    // (one `event:` line, one `data:` line, then `\n\n`) so we unfold them
    // in-place instead of pulling an sse-client dep.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneEvent: {
      requestId: string;
      planOutput: unknown;
      scaffoldkitInput: unknown | null;
      outputTarGz?: string;
    } | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let frameEnd: number;
      while ((frameEnd = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, frameEnd);
        buf = buf.slice(frameEnd + 2);
        const event = /^event:\s*(.*)$/m.exec(frame)?.[1]?.trim() ?? "message";
        const data = /^data:\s*(.*)$/m.exec(frame)?.[1] ?? "";
        if (!data) continue;
        if (event === "progress") {
          if (options.onProgress) {
            try {
              const payload = JSON.parse(data) as {
                line?: string;
                stream?: "stdout" | "stderr";
              };
              if (payload.line) options.onProgress(payload.line, payload.stream ?? "stdout");
            } catch {
              // Malformed progress frames aren't worth aborting the run.
            }
          }
        } else if (event === "done") {
          doneEvent = JSON.parse(data);
        } else if (event === "error") {
          const payload = JSON.parse(data) as { message?: string; exitCode?: number };
          throw new PlanforgeClientError(
            `planforge error (exit ${payload.exitCode ?? "unknown"}): ${payload.message ?? "no message"}`,
          );
        }
      }
    }

    if (!doneEvent) {
      throw new PlanforgeClientError("planforge stream ended without a done event");
    }
    if (!doneEvent.outputTarGz) {
      // Older deploys before feat/generate-returns-tarball shipped would
      // hit this — once the fleet is on the tarball contract (current
      // deploy state, 2026-04-18+), this branch is unreachable.
      throw new PlanforgeClientError(
        "planforge done event did not include outputTarGz — service deploy predates the tarball contract",
      );
    }

    await extractTarGzInto(options.outdir, doneEvent.outputTarGz);

    return {
      requestId: doneEvent.requestId,
      planOutput: doneEvent.planOutput,
      scaffoldkitInput: doneEvent.scaffoldkitInput ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pipe the base64 gzipped tarball into `tar -xzf - -C outdir`. Going
 * through the system `tar` binary keeps the dep tree minimal and matches
 * what the server-side wrote it with, so round-trip semantics (symlinks,
 * empty dirs, modes) can't drift between packer and unpacker.
 *
 * The Next.js production image (node:22-alpine / node:22-slim — see
 * `Dockerfile`) has GNU tar preinstalled. Bind-mount-based dev on the
 * host also has it.
 */
async function extractTarGzInto(outdir: string, base64: string): Promise<void> {
  const buf = Buffer.from(base64, "base64");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", "-", "-C", outdir], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new PlanforgeClientError(`tar exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(buf);
  });
}
