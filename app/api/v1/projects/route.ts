import { NextRequest, NextResponse } from "next/server";
import { validateApiToken, checkRateLimit, prisma } from "@/lib/db";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { resolvePlanforgeOutputPaths } from "@/lib/planforge-output";
import { buildPlanforgeInput } from "@/lib/planforge-orchestrator";
import { executePlanforgeWorkflow } from "@/lib/planforge-runner";
import { runPostScaffoldReview } from "@/lib/post-scaffold-review";
import { runCommand } from "@/lib/subprocess";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const PLANFORGE_PATH = process.env.PLANFORGE_PATH ?? "/root/.openclaw/workspace/git/agent-planforge";
const GENERATION_TIMEOUT_MS = 30_000;

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
    return NextResponse.json({ error: "Missing X-API-Key header" }, { status: 401 });
  }

  // Validate API token
  const tokenRecord = await validateApiToken(apiKey);

  if (!tokenRecord) {
    return NextResponse.json({ error: "Invalid or revoked API token" }, { status: 401 });
  }

  // Check rate limit
  const rateLimit = await checkRateLimit(tokenRecord.userId);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
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
        { error: "Missing required fields: projectName, summary" },
        { status: 400 }
      );
    }

    // Get user's GitHub PAT
    const user = tokenRecord.user;

    if (!user.githubPat) {
      return NextResponse.json(
        { error: "GitHub PAT not configured. Please add it in your dashboard." },
        { status: 400 }
      );
    }

    sessionId = randomUUID();
    const tempDir = path.join(TEMP_ROOT, sessionId);
    await fs.mkdir(tempDir, { recursive: true });

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

    // Step 2: Run scaffoldkit from-planforge
    const artifacts = await resolvePlanforgeOutputPaths(tempDir);
    const scaffoldInputPath = artifacts.scaffoldkitInputPath;
    const scaffoldkitPython = process.env.SCAFFOLDKIT_PYTHON ?? "/tmp/sk-venv/bin/python3";
    const scaffoldkitExists = await fs.access(scaffoldInputPath).then(() => true).catch(() => false);

    if (scaffoldkitExists) {
      await runCommand(
        scaffoldkitPython,
        [
          "-m",
          "scaffoldkit.cli",
          "from-planforge",
          scaffoldInputPath,
          "--target",
          tempDir,
          "--overwrite",
          "--no-install",
        ],
        { cwd: tempDir, timeoutMs: GENERATION_TIMEOUT_MS, verbose: true }
      ).catch((err: Error) => {
        // Non-blocking - planforge output is still useful
        console.error("scaffoldkit failed (non-blocking):", err.message);
      });
    }

    await runPostScaffoldReview(tempDir);

    // Step 3: Create GitHub repo and push
    const repoUrl = await createAndPushRepo(
      tempDir,
      input.projectName,
      user.githubPat,
      user.githubOwner || user.email.split("@")[0]
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
  } catch (error: any) {
    console.error("Project generation failed:", error);

    if (sessionId) {
      const tempDir = path.join(TEMP_ROOT, sessionId);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return NextResponse.json(
      {
        error: "Project generation failed",
        details: error.message,
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
  await git(["config", "user.email", "forge@project-forge.dev"]);
  await git(["config", "user.name", "project-forge"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Initial commit via project-forge"]);
  await git(["branch", "-M", "main"]);
  await git(["remote", "add", "origin", pushUrl]);
  await git(["push", "-u", "origin", "main"], 30_000);

  return repoUrl;
}
