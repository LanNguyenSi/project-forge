import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import * as fs from "fs/promises";
import * as path from "path";
import type { PublishResponse, ErrorResponse } from "../../../lib/types";
import { runCommand } from "@/lib/subprocess";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";

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

    // Get the logged-in user's GitHub token
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (!user?.githubPat) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "GitHub not connected. Please connect GitHub in Settings first." },
        { status: 400 }
      );
    }

    const userToken = user.githubPat;

    const tempDir = path.join(TEMP_ROOT, sessionId);
    const stat = await fs.stat(tempDir).catch(() => null);
    if (!stat) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Session not found or expired" },
        { status: 404 }
      );
    }

    // 1. Create GitHub repo using the user's own token
    const repoRes = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `token ${userToken}`,
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
      const errorText = await repoRes.text();
      let errorMessage = "Failed to create GitHub repository. ";

      if (repoRes.status === 401) {
        errorMessage = "Invalid or expired GitHub token. Please reconnect GitHub in Settings.";
      } else if (repoRes.status === 403) {
        errorMessage = "GitHub token lacks required permissions. Please ensure it has 'repo' scope.";
      } else if (repoRes.status === 422) {
        try {
          const errorData = JSON.parse(errorText) as { message?: string };
          if (errorData.message?.includes("name already exists")) {
            errorMessage = "A repository with this name already exists in your account. Please choose a different name.";
          } else {
            errorMessage += errorData.message ?? "Please check the repository name.";
          }
        } catch {
          errorMessage += "Please check the repository name and try again.";
        }
      } else {
        errorMessage += `(${repoRes.status})`;
      }

      return NextResponse.json<ErrorResponse>(
        { ok: false, error: errorMessage },
        { status: repoRes.status === 401 || repoRes.status === 403 ? 400 : 500 }
      );
    }

    const repo = await repoRes.json() as { html_url: string; clone_url: string; default_branch: string };

    // 2. Git init + commit + push using user's token
    await runGitCommands(tempDir, repo.clone_url, userToken);

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
): Promise<void> {
  const authedUrl = cloneUrl.replace("https://", `https://${token}@`);

  const git = (args: string[], timeoutMs = 10_000) =>
    runCommand("git", args, { cwd: repoPath, timeoutMs });

  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "forge@project-forge.dev"]);
  await git(["config", "user.name", "project-forge"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "feat: initial scaffold\n\nGenerated with project-forge\nPlanned with agent-planforge (https://github.com/LanNguyenSi/agent-planforge) · Scaffolded with scaffoldkit (https://github.com/LanNguyenSi/scaffoldkit)"]);
  await git(["remote", "add", "origin", authedUrl]);
  await git(["push", "-u", "origin", "main"], 30_000);
}
