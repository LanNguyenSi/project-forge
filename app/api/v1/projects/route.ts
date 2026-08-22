import { NextRequest, NextResponse } from "next/server";
import { validateApiToken, checkRateLimit, prisma } from "@/lib/db";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { excludePlanforgeArtifactsFromPublish, prunePublishedPlanforgeIndex } from "@/lib/planforge-output";
import { buildPlanforgeInput } from "@/lib/planforge-orchestrator";
import { runPlanforgeViaHttp, PlanforgeClientError, assertScaffoldkitRan } from "@/lib/planforge-client";
import { runPostScaffoldReview } from "@/lib/post-scaffold-review";
import { runCommand } from "@/lib/subprocess";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
// End-to-end cap for plan + scaffold + tar + SSE + untar + git push.
// Server-side scaffoldkit timeout is 5 min; 3 min here leaves headroom.
const GENERATION_TIMEOUT_MS = 3 * 60_000;

interface ProjectRequest {
  projectName: string;
  summary: string;
  features?: string[];
  constraints?: string[];
  targetUsers?: string[];
}

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 50), 200);
  const offset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  const includeDeleted = req.nextUrl.searchParams.get("includeDeleted") === "true";

  const where = {
    userId: tokenRecord.userId,
    ...(!includeDeleted && { deletedAt: null }),
  };

  const [projects, total] = await Promise.all([
    prisma.usageLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: { id: true, repoUrl: true, createdAt: true, deletedAt: true },
    }),
    prisma.usageLog.count({ where }),
  ]);

  return NextResponse.json({
    ok: true,
    projects: projects.map((p: { id: string; repoUrl: string | null; createdAt: Date }) => ({
      id: p.id,
      repoUrl: p.repoUrl ?? "",
      projectName: p.repoUrl?.split("/").pop() ?? "",
      createdAt: p.createdAt.toISOString(),
    })),
    total,
    limit,
    offset,
  });
}

export async function DELETE(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing id parameter" }, { status: 400 });
  }

  const entry = await prisma.usageLog.findFirst({
    where: { id, userId: tokenRecord.userId },
  });

  if (!entry) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  if (entry.deletedAt) {
    return NextResponse.json({ ok: false, error: "Already deleted" }, { status: 409 });
  }

  await prisma.usageLog.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  // Validate API token
  const tokenRecord = await validateApiToken(apiKey);

  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  // Check rate limit
  const rateLimit = await checkRateLimit(tokenRecord.userId);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: "Rate limit exceeded",
        details: `Maximum 10 projects per day. Used: ${rateLimit.used}/10`,
      },
      { status: 429 }
    );
  }

  let sessionId: string | null = null;

  try {
    const input: ProjectRequest = await req.json();

    if (!input.projectName || !input.summary) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: projectName, summary" },
        { status: 400 }
      );
    }

    // Get user's GitHub PAT
    const user = tokenRecord.user;

    if (!user.githubPat) {
      return NextResponse.json(
        { ok: false, error: "GitHub PAT not configured. Please add it in your dashboard." },
        { status: 400 }
      );
    }

    sessionId = randomUUID();
    const tempDir = path.join(TEMP_ROOT, sessionId);
    await fs.mkdir(tempDir, { recursive: true });

    // Plan + scaffold via the planforge HTTP service. The response tarball
    // contains both planning artifacts and the scaffolded project tree.
    const { planforgeInput } = await buildPlanforgeInput({
      projectName: input.projectName,
      summary: input.summary,
      features: input.features ?? [],
      constraints: input.constraints ?? [],
      targetUsers: input.targetUsers,
    });
    const baseUrl = process.env.PLANFORGE_URL;
    const token = process.env.PLANFORGE_SERVICE_TOKEN;
    if (!baseUrl || !token) {
      throw new PlanforgeClientError(
        "PLANFORGE_URL and PLANFORGE_SERVICE_TOKEN are required",
      );
    }
    const planforgeResult = await runPlanforgeViaHttp({
      baseUrl,
      token,
      input: planforgeInput,
      outdir: tempDir,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
    // Fail loud if scaffoldkit didn't run — pushing a planning-only repo
    // to the user's GitHub with no error signal is a silent regression.
    assertScaffoldkitRan(planforgeResult);

    await runPostScaffoldReview(tempDir);

    // Step 3: Create GitHub repo and push
    const repoUrl = await createAndPushRepo(
      tempDir,
      input.projectName,
      user.githubPat,
      user.githubOwner || user.githubLogin || user.email?.split("@")[0] || "user"
    );

    // Log usage
    await prisma.usageLog.create({
      data: {
        userId: tokenRecord.userId,
        tokenId: tokenRecord.id,
        repoUrl,
      },
    });

    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    return NextResponse.json({
      ok: true,
      result: {
        repoUrl,
        cloneUrl: repoUrl + ".git",
        projectName: input.projectName,
      },
    });
  } catch (error: unknown) {
    console.error("Project generation failed:", error);

    if (sessionId) {
      const tempDir = path.join(TEMP_ROOT, sessionId);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json(
      {
        ok: false,
        error: "Project generation failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function createAndPushRepo(
  projectDir: string,
  repoName: string,
  githubPat: string,
  owner: string
): Promise<string> {
  // Create GitHub repo via API
  const createRes = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubPat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: repoName,
      private: false,
      auto_init: false,
    }),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    
    // Provide specific error messages based on status code
    if (createRes.status === 401) {
      throw new Error(
        "Invalid or expired GitHub PAT. Please update your GitHub Personal Access Token in the dashboard."
      );
    } else if (createRes.status === 403) {
      throw new Error(
        "GitHub PAT lacks required permissions. Please ensure your PAT has 'repo' scope enabled."
      );
    } else if (createRes.status === 422) {
      let message = "Repository validation failed. ";
      try {
        const errorData = JSON.parse(errorText);
        if (errorData.message?.includes("name already exists")) {
          message += "A repository with this name already exists in your account.";
        } else {
          message += errorData.message || "Please check the repository name.";
        }
      } catch {
        message += "Please check the repository name and try again.";
      }
      throw new Error(message);
    } else {
      throw new Error(`GitHub repo creation failed (${createRes.status}): ${errorText}`);
    }
  }

  const repo = await createRes.json();
  const repoUrl = repo.html_url;
  const pushUrl = repo.clone_url.replace("https://", `https://${githubPat}@`);

  // Initialize git and push
  const git = (args: string[], timeoutMs = 10_000) =>
    runCommand("git", args, { cwd: projectDir, timeoutMs });

  await git(["init"]);
  await excludePlanforgeArtifactsFromPublish(projectDir);
  await prunePublishedPlanforgeIndex(projectDir);
  await git(["config", "user.email", "forge@project-forge.dev"]);
  await git(["config", "user.name", "project-forge"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Initial commit via project-forge"]);
  await git(["branch", "-M", "main"]);
  await git(["remote", "add", "origin", pushUrl]);
  await git(["push", "-u", "origin", "main"], 30_000);

  return repoUrl;
}
