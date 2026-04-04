import * as path from "path";
import { runCommand } from "@/lib/subprocess";

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
    { cwd: options.outdir, timeoutMs: options.timeoutMs }
  );

  return { mode: "direct" };
}
