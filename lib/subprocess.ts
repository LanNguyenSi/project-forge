import { spawn } from "child_process";

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  /** Log stdout/stderr to console (default: false). */
  verbose?: boolean;
}

/**
 * Spawn a child process and resolve on exit code 0.
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
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to execute ${cmd}: ${err.message}`));
    });

    proc.on("exit", (code) => {
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
    });
  });
}
