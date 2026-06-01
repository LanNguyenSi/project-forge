import { NextRequest, NextResponse } from "next/server";
import { validateApiToken, checkRateLimit, prisma } from "@/lib/db";
import * as fs from "fs/promises";
import * as path from "path";
import { excludePlanforgeArtifactsFromPublish } from "@/lib/planforge-output";
import type { ErrorResponse } from "@/lib/types";
import { summarizePublishError } from "@/lib/publish-error";
import { runCommand } from "@/lib/subprocess";
import { SESSION_UUID_RE, readForgeMeta, isSessionExpired } from "@/lib/v1-shared";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(tokenRecord.userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Rate limit exceeded", details: `Used: ${rateLimit.used}/10` },
      { status: 429 },
    );
  }

  let tempDir = "";
  try {
    const { sessionId } = (await req.json()) as { sessionId?: string };

    if (!sessionId || !SESSION_UUID_RE.test(sessionId)) {
      return NextResponse.json({ ok: false, error: "Missing or invalid sessionId" }, { status: 400 });
    }

    tempDir = path.join(TEMP_ROOT, sessionId);
    const stat = await fs.stat(tempDir).catch(() => null);
    if (!stat) {
      return NextResponse.json({ ok: false, error: "Session not found or expired" }, { status: 404 });
    }

    const meta = await readForgeMeta(tempDir);

    if (meta.userId !== tokenRecord.userId) {
      return NextResponse.json({ ok: false, error: "Session not found or expired" }, { status: 404 });
    }

    if (isSessionExpired(meta)) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json({ ok: false, error: "Session expired" }, { status: 404 });
    }

    // Atomic publish lock — prevents race condition on concurrent requests
    const publishedMarker = path.join(tempDir, ".forge-published");
    const lockFd = await fs.open(publishedMarker, "wx").catch(() => null);
    if (!lockFd) {
      return NextResponse.json({ ok: false, error: "Session already published" }, { status: 409 });
    }
    await lockFd.writeFile(new Date().toISOString());
    await lockFd.close();

    // Get user's GitHub PAT
    const user = tokenRecord.user;
    if (!user.githubPat) {
      // Remove lock so retry is possible after PAT is configured
      await fs.rm(publishedMarker, { force: true }).catch(() => {});
      return NextResponse.json(
        { ok: false, error: "GitHub PAT not configured. Please add it in your dashboard." },
        { status: 400 },
      );
    }

    // Create GitHub repo and push
    const repoUrl = await createAndPushRepo(tempDir, meta.projectName, user.githubPat);

    // Log usage
    await prisma.usageLog.create({
      data: {
        userId: tokenRecord.userId,
        tokenId: tokenRecord.id,
        repoUrl,
      },
    });

    // Cleanup temp dir
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    return NextResponse.json({
      ok: true,
      result: {
        repoUrl,
        cloneUrl: repoUrl + ".git",
        projectName: meta.projectName,
      },
    });
  } catch (error: unknown) {
    // Sanitize any embedded PAT before it touches logs or the response.
    // First the known `x-access-token:TOKEN@` remote-URL form, then a
    // defense-in-depth scrub of bare GitHub token shapes in case the auth
    // embedding ever changes (Authorization header echo, `https://TOKEN@`, …).
    const raw = error instanceof Error ? error.message : String(error);
    const sanitized = raw
      .replace(/x-access-token:[^@]+@/g, "x-access-token:***@")
      .replace(/\b(gho|ghp|ghu|ghs)_[A-Za-z0-9]+/g, "$1_***")
      .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***");
    console.error("Publish failed:", sanitized);

    // Cleanup temp dir on failure (PAT may be in .git/config)
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

    // Surface *why* publish failed instead of an opaque "Publish failed":
    // project-pilot forwards `error` to the UI, so the reason (e.g. a missing
    // `workflow` OAuth scope on a git push) reaches the user. `details` carries
    // the fuller sanitized message for direct API callers.
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: `Publish failed: ${summarizePublishError(sanitized)}`, details: sanitized.slice(0, 1000) },
      { status: 500 },
    );
  }
}

async function createAndPushRepo(projectDir: string, repoName: string, githubPat: string): Promise<string> {
  const createRes = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubPat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: repoName, private: false, auto_init: false }),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    if (createRes.status === 422) {
      try {
        const errorData = JSON.parse(errorText) as { message?: string };
        if (errorData.message?.includes("name already exists")) {
          throw new Error("repo_name_exists");
        }
      } catch (e) {
        if (e instanceof Error && e.message === "repo_name_exists") throw e;
      }
    }
    throw new Error(`github_${createRes.status}`);
  }

  const repo = (await createRes.json()) as { html_url: string; clone_url: string };

  // Remove forge metadata before committing
  await fs.rm(path.join(projectDir, ".forge-meta.json"), { force: true }).catch(() => {});
  await fs.rm(path.join(projectDir, ".forge-published"), { force: true }).catch(() => {});

  // Embed PAT in the remote URL for auth (standard CI pattern).
  // clone_url is https://github.com/user/repo.git — inject token as username.
  const authedUrl = repo.clone_url.replace("https://", `https://x-access-token:${githubPat}@`);

  const gitEnv = { GIT_TERMINAL_PROMPT: "0" };

  const git = (args: string[], timeoutMs = 10_000) =>
    runCommand("git", args, { cwd: projectDir, timeoutMs, env: { ...process.env, ...gitEnv } });

  await git(["init", "-b", "main"]);
  await excludePlanforgeArtifactsFromPublish(projectDir);
  await git(["config", "user.email", "forge@project-forge.dev"]);
  await git(["config", "user.name", "project-forge"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "feat: initial scaffold\n\nGenerated with project-forge\nPlanned with agent-planforge · Scaffolded with scaffoldkit"]);
  await git(["remote", "add", "origin", authedUrl]);
  await git(["push", "-u", "origin", "main"], 30_000);
  // Neutralize PAT from .git/config immediately after push
  await git(["remote", "set-url", "origin", repo.clone_url]);

  return repo.html_url;
}
