import { NextRequest, NextResponse } from "next/server";
import { validateApiToken, checkRateLimit, prisma } from "@/lib/db";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const PLANFORGE_PATH = process.env.PLANFORGE_PATH ?? "/root/.openclaw/workspace/git/agent-planforge";
const SCAFFOLDKIT_PATH = process.env.SCAFFOLDKIT_PATH ?? "/root/.openclaw/workspace/git/scaffoldkit";
const GENERATION_TIMEOUT_MS = 30_000;

interface ProjectRequest {
  projectName: string;
  summary: string;
  features?: string[];
  constraints?: string[];
  targetUsers?: string[];
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
    const planforgeInput = {
      projectName: input.projectName,
      summary: input.summary,
      targetUsers: (input.targetUsers && input.targetUsers.length > 0) ? input.targetUsers : ["developers"],
      coreFeatures: (input.features && input.features.length > 0) ? input.features : ["core functionality"],
      constraints: input.constraints ?? [],
    };

    const inputPath = path.join(tempDir, "project-input.json");
    await fs.writeFile(inputPath, JSON.stringify(planforgeInput, null, 2));

    await runCommand(
      "node",
      [
        path.join(PLANFORGE_PATH, "scripts", "bootstrap-plan.js"),
        "--input",
        inputPath,
        "--outdir",
        tempDir,
        "--no-install",
      ],
      tempDir,
      GENERATION_TIMEOUT_MS
    );

    // Step 2: Run scaffoldkit from-planforge
    const scaffoldInputPath = path.join(tempDir, "scaffoldkit-input.json");
    const scaffoldkitPython = process.env.SCAFFOLDKIT_PYTHON ?? "/app/.sk-venv/bin/python3";
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
          "--no-install",
        ],
        tempDir,
        GENERATION_TIMEOUT_MS
      ).catch((err: Error) => {
        // Non-blocking - planforge output is still useful
        console.error("scaffoldkit failed (non-blocking):", err.message);
      });
    }

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

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: false, timeout });

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
        console.log(`${cmd} output:`, stdout);
        if (stderr) console.warn(`${cmd} stderr:`, stderr);
        resolve();
      } else {
        reject(
          new Error(`${cmd} exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`)
        );
      }
    });
  });
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
  await runCommand("git", ["init"], projectDir, 10_000);
  await runCommand("git", ["config", "user.email", "forge@project-forge.dev"], projectDir, 5_000);
  await runCommand("git", ["config", "user.name", "project-forge"], projectDir, 5_000);
  await runCommand("git", ["add", "."], projectDir, 10_000);
  await runCommand("git", ["commit", "-m", "Initial commit via project-forge"], projectDir, 10_000);
  await runCommand("git", ["branch", "-M", "main"], projectDir, 10_000);
  await runCommand("git", ["remote", "add", "origin", pushUrl], projectDir, 10_000);
  await runCommand("git", ["push", "-u", "origin", "main"], projectDir, 30_000);

  return repoUrl;
}
