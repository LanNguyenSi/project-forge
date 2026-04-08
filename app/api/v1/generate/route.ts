import { NextRequest, NextResponse } from "next/server";
import { validateApiToken } from "@/lib/db";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { ErrorResponse } from "@/lib/types";
import { resolvePlanforgeOutputPaths } from "@/lib/planforge-output";
import { buildPlanforgeInput } from "@/lib/planforge-orchestrator";
import { executePlanforgeWorkflow } from "@/lib/planforge-runner";
import { runPostScaffoldReview } from "@/lib/post-scaffold-review";
import { runCommand } from "@/lib/subprocess";
import { validateProjectName, readPreviewData } from "@/lib/v1-shared";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const PLANFORGE_PATH = process.env.PLANFORGE_PATH ?? "/root/.openclaw/workspace/git/agent-planforge";
const GENERATION_TIMEOUT_MS = 30_000;

interface GenerateRequest {
  projectName: string;
  summary: string;
  features?: string[];
  constraints?: string[];
  targetUsers?: string[];
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  // Note: generate does NOT count against the daily project rate limit.
  // Only publish does, since generate doesn't create a repo.

  let sessionId: string | null = null;

  try {
    const input: GenerateRequest = await req.json();

    if (!input.projectName || !input.summary) {
      return NextResponse.json({ ok: false, error: "Missing required fields: projectName, summary" }, { status: 400 });
    }

    if (!validateProjectName(input.projectName)) {
      return NextResponse.json({ ok: false, error: "Invalid projectName. Use only letters, numbers, dots, hyphens, underscores (max 100 chars)." }, { status: 400 });
    }

    sessionId = randomUUID();
    const tempDir = path.join(TEMP_ROOT, sessionId);
    await fs.mkdir(tempDir, { recursive: true });

    // Store metadata for later preview/publish
    await fs.writeFile(
      path.join(tempDir, ".forge-meta.json"),
      JSON.stringify({
        tokenId: tokenRecord.id,
        userId: tokenRecord.userId,
        projectName: input.projectName,
        createdAt: new Date().toISOString(),
      }),
    );

    // Step 1: Run planforge
    const { planforgeInput } = await buildPlanforgeInput({
      projectName: input.projectName,
      summary: input.summary,
      features: input.features ?? [],
      constraints: input.constraints ?? [],
      targetUsers: input.targetUsers,
    });

    const inputPath = path.join(tempDir, "project-input.json");
    await fs.writeFile(inputPath, JSON.stringify(planforgeInput, null, 2));

    await executePlanforgeWorkflow({
      planforgePath: PLANFORGE_PATH,
      inputPath,
      outdir: tempDir,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });

    // Step 2: Run scaffoldkit
    const artifacts = await resolvePlanforgeOutputPaths(tempDir);
    const scaffoldkitPython = process.env.SCAFFOLDKIT_PYTHON ?? "/tmp/sk-venv/bin/python3";
    const scaffoldkitExists = await fs.access(artifacts.scaffoldkitInputPath).then(() => true).catch(() => false);

    if (scaffoldkitExists) {
      await runCommand(
        scaffoldkitPython,
        ["-m", "scaffoldkit.cli", "from-planforge", artifacts.scaffoldkitInputPath, "--target", tempDir, "--overwrite", "--no-install"],
        { cwd: tempDir, timeoutMs: GENERATION_TIMEOUT_MS, verbose: true },
      ).catch((err: Error) => {
        console.error("scaffoldkit failed (non-blocking):", err.message);
      });
    }

    await runPostScaffoldReview(tempDir);

    const preview = await readPreviewData(tempDir, input.projectName);

    return NextResponse.json({ ok: true, sessionId, preview });
  } catch (error: unknown) {
    console.error("Generation failed:", error);

    if (sessionId) {
      const tempDir = path.join(TEMP_ROOT, sessionId);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Generation failed" },
      { status: 500 },
    );
  }
}
