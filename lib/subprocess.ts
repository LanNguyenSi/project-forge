import { spawn } from "child_process";

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  /** Log stdout/stderr to console (default: false). */
  verbose?: boolean;
  /** Custom environment variables (merged with process.env if not provided). */
  env?: NodeJS.ProcessEnv;
  /**
   * How long to wait for the stdio streams to end after the child exited
   * (default: 2000). A grandchild that inherited the pipes can keep them open
   * after the child is gone; once this elapses the call settles with the
   * output captured so far.
   */
  closeGraceMs?: number;
}

/**
 * Spawn a child process and resolve on exit code 0.
 * Settles on "close" (after the stdio streams ended) so stdout/stderr are
 * complete; "exit" can fire while output is still unread. If a grandchild
 * holds the pipes open, settles a bounded time after "exit" instead.
 * Rejects with a descriptive error that includes captured stdout/stderr.
 */
export function runCommand(
  cmd: string,
  args: string[],
  options: RunCommandOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      shell: false,
      timeout: options.timeoutMs,
      env: options.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);

      if (options.verbose) {
        if (stdout) console.log(`${cmd} output:`, stdout);
        if (stderr) console.warn(`${cmd} stderr:`, stderr);
      }

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${cmd} exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`
          )
        );
      }
    };

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      reject(new Error(`Failed to execute ${cmd}: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (settled) return;
      graceTimer = setTimeout(
        () => finish(code),
        options.closeGraceMs ?? 2000
      );
    });

    proc.on("close", (code) => finish(code));
  });
}
