import { NextRequest, NextResponse } from "next/server";
import { validateApiToken } from "@/lib/db";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { ErrorResponse } from "@/lib/types";
import { buildPlanforgeInput } from "@/lib/planforge-orchestrator";
import { runPlanforgeViaHttp, PlanforgeClientError } from "@/lib/planforge-client";
import { runPostScaffoldReview } from "@/lib/post-scaffold-review";
import { validateProjectName, readPreviewData } from "@/lib/v1-shared";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
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

    // Plan + scaffold in one call. The planforge service runs scaffoldkit
    // in-container (per agent-planforge PR #62) so the response tarball
    // already contains both planning artifacts AND the scaffolded project
    // tree extracted into tempDir. Default `scaffold: true` is what we want.
    const baseUrl = process.env.PLANFORGE_URL;
    const token = process.env.PLANFORGE_SERVICE_TOKEN;
    if (!baseUrl || !token) {
      throw new PlanforgeClientError(
        "PLANFORGE_URL and PLANFORGE_SERVICE_TOKEN are required",
      );
    }
    await runPlanforgeViaHttp({
      baseUrl,
      token,
      input: planforgeInput,
      outdir: tempDir,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });

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
