import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import type { PublishResponse, ErrorResponse } from "../../../lib/types";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";

export async function POST(req: NextRequest) {
  try {
    const { sessionId, projectName } = await req.json() as {
      sessionId: string;
      projectName: string;
    };

    if (!sessionId || !projectName) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Missing sessionId or projectName" },
        { status: 400 }
      );
    }

    if (!GITHUB_TOKEN || !GITHUB_OWNER) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "GitHub credentials not configured" },
        { status: 500 }
      );
    }

    const tempDir = path.join(TEMP_ROOT, sessionId);
    const stat = await fs.stat(tempDir).catch(() => null);
    if (!stat) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Session not found or expired" },
        { status: 404 }
      );
    }

    // 1. Create GitHub repo
    const repoRes = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectName,
        description: `Generated with project-forge · planforge + scaffoldkit`,
        private: false,
        auto_init: false,
      }),
    });

    if (!repoRes.ok) {
      const err = await repoRes.json() as { message?: string };
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: `Failed to create GitHub repo: ${err.message ?? repoRes.status}` },
        { status: 500 }
      );
    }

    const repo = await repoRes.json() as { html_url: string; clone_url: string; default_branch: string };

    // 2. Git init + commit + push from temp dir
    await runGitCommands(tempDir, repo.clone_url, GITHUB_TOKEN, projectName);

    // 3. Cleanup temp dir
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    return NextResponse.json<PublishResponse>({
      ok: true,
      result: {
        repoUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch ?? "main",
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Publish failed", details: msg },
      { status: 500 }
    );
  }
}

async function runGitCommands(
  repoPath: string,
  cloneUrl: string,
  token: string,
  projectName: string
): Promise<void> {
  const authedUrl = cloneUrl.replace("https://", `https://${token}@`);

  const commands = [
    ["git", "init", "-b", "main"],
    ["git", "config", "user.email", "forge@project-forge.dev"],
    ["git", "config", "user.name", "project-forge"],
    ["git", "add", "-A"],
    ["git", "commit", "-m", `feat: initial scaffold\n\nGenerated with project-forge\nPlanned with agent-planforge · Scaffolded with scaffoldkit`],
    ["git", "remote", "add", "origin", authedUrl],
    ["git", "push", "-u", "origin", "main"],
  ];

  for (const [cmd, ...args] of commands) {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, { cwd: repoPath, stdio: "pipe" });
      let stderr = "";
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} ${args[0]} failed (${code}): ${stderr}`));
      });
      proc.on("error", reject);
    });
  }
}
