import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import * as fs from "fs/promises";
import * as path from "path";
import { excludePlanforgeArtifactsFromPublish } from "@/lib/planforge-output";
import type { PublishResponse, ErrorResponse } from "../../../lib/types";
import { runCommand } from "@/lib/subprocess";
import { SESSION_UUID_RE, readForgeMeta, isSessionExpired } from "@/lib/v1-shared";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";

export async function POST(req: NextRequest) {
  // Hoisted so the catch block can clean up the temp dir on the throw path
  // (the PAT may be in .git/config until the post-push set-url + rm run).
  let tempDir = "";
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

    if (!SESSION_UUID_RE.test(sessionId)) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Invalid sessionId" },
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

    tempDir = path.join(TEMP_ROOT, sessionId);
    const stat = await fs.stat(tempDir).catch(() => null);
    if (!stat) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Session not found or expired" },
        { status: 404 }
      );
    }

    // Bind the session dir to its creator (IDOR guard). Without this any
    // authenticated user who learns a valid UUID could publish another
    // user's scaffold to their own GitHub account. Mirrors the v1 route's
    // `meta.userId !== tokenRecord.userId` check, scoped by session.user.id.
    // A missing/unreadable meta file fails closed (404).
    const meta = await readForgeMeta(tempDir).catch(() => null);
    if (!meta || meta.userId !== session.user.id) {
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Session not found or expired" },
        { status: 404 }
      );
    }

    if (isSessionExpired(meta)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json<ErrorResponse>(
        { ok: false, error: "Session expired" },
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
    // Sanitize any embedded PAT before it reaches the client or logs. A
    // failed `git push` to an authed remote echoes the URL (and thus the
    // token) in git's stderr. Mirrors the v1 route's scrubbing: the known
    // `TOKEN@`/`x-access-token:TOKEN@` remote form plus bare GitHub token
    // shapes as defense in depth.
    const raw = error instanceof Error ? error.message : String(error);
    const sanitized = raw
      .replace(/x-access-token:[^@]+@/g, "x-access-token:***@")
      .replace(/https:\/\/[^@\s/]+@/g, "https://***@")
      .replace(/\b(gho|ghp|ghu|ghs)_[A-Za-z0-9]+/g, "$1_***")
      .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***");
    console.error("Publish failed:", sanitized);

    // Always remove the temp dir on failure: on the throw path the cleanup
    // at the success branch never runs, leaving the PAT in .git/config.
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Publish failed", details: sanitized },
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
    runCommand("git", args, {
      cwd: repoPath,
      timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

  // Strip forge bookkeeping so the ownership record never lands in the
  // published repo (matches the v1 createAndPushRepo flow).
  await fs.rm(path.join(repoPath, ".forge-meta.json"), { force: true }).catch(() => {});
  await fs.rm(path.join(repoPath, ".forge-published"), { force: true }).catch(() => {});

  await git(["init", "-b", "main"]);
  await excludePlanforgeArtifactsFromPublish(repoPath);
  await git(["config", "user.email", "forge@project-forge.dev"]);
  await git(["config", "user.name", "project-forge"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "feat: initial scaffold\n\nGenerated with project-forge\nPlanned with agent-planforge (https://github.com/LanNguyenSi/agent-planforge) · Scaffolded with scaffoldkit (https://github.com/LanNguyenSi/scaffoldkit)"]);
  await git(["remote", "add", "origin", authedUrl]);
  await git(["push", "-u", "origin", "main"], 30_000);
  // Neutralize the PAT from .git/config immediately after push so a token
  // never survives in the temp dir if later cleanup is skipped.
  await git(["remote", "set-url", "origin", cloneUrl]);
}
