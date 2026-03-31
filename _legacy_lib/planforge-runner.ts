import { spawn } from "child_process";
import * as path from "path";

export interface PlanforgeRunMetadata {
  mode: "direct";
}

interface ExecutePlanforgeOptions {
  planforgePath: string;
  inputPath: string;
  outdir: string;
  timeoutMs: number;
}

function plannerScript(planforgePath: string): string {
  return path.join(planforgePath, "scripts", "bootstrap-plan.js");
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: false, timeout: timeoutMs });

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
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${cmd} exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`)
        );
      }
    });
  });
}

export async function executePlanforgeWorkflow(
  options: ExecutePlanforgeOptions
): Promise<PlanforgeRunMetadata> {
  await runCommand(
    "node",
    [
      plannerScript(options.planforgePath),
      "--input",
      options.inputPath,
      "--outdir",
      options.outdir,
      "--no-install",
    ],
    options.outdir,
    options.timeoutMs
  );

  return { mode: "direct" };
}
