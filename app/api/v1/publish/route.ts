import { NextRequest, NextResponse } from "next/server";
import { validateApiToken, checkRateLimit, prisma } from "@/lib/db";
import * as fs from "fs/promises";
import * as path from "path";
import type { ErrorResponse } from "@/lib/types";
import { runCommand } from "@/lib/subprocess";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

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

  try {
    const { sessionId } = (await req.json()) as { sessionId?: string };

    if (!sessionId) {
      return NextResponse.json({ ok: false, error: "Missing sessionId" }, { status: 400 });
    }

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return NextResponse.json({ ok: false, error: "Invalid sessionId format" }, { status: 400 });
    }

    const tempDir = path.join(TEMP_ROOT, sessionId);
    const stat = await fs.stat(tempDir).catch(() => null);
    if (!stat) {
      return NextResponse.json({ ok: false, error: "Session not found or expired" }, { status: 404 });
    }

    // Check TTL
    if (Date.now() - stat.mtimeMs > SESSION_TTL_MS) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return NextResponse.json({ ok: false, error: "Session expired" }, { status: 404 });
    }

    // Verify ownership
    const metaPath = path.join(tempDir, ".forge-meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
      tokenId: string;
      userId: string;
      projectName: string;
    };

    if (meta.userId !== tokenRecord.userId) {
      return NextResponse.json({ ok: false, error: "Session not found or expired" }, { status: 404 });
    }

    // Check if already published
    const publishedMarker = path.join(tempDir, ".forge-published");
    const alreadyPublished = await fs.access(publishedMarker).then(() => true).catch(() => false);
    if (alreadyPublished) {
      return NextResponse.json({ ok: false, error: "Session already published" }, { status: 409 });
    }

    // Get user's GitHub PAT
    const user = tokenRecord.user;
    if (!user.githubPat) {
      return NextResponse.json(
        { ok: false, error: "GitHub PAT not configured. Please add it in your dashboard." },
        { status: 400 },
      );
    }

    // Create GitHub repo
    const repoUrl = await createAndPushRepo(tempDir, meta.projectName, user.githubPat, user.githubOwner || user.email.split("@")[0]);

    // Mark as published
    await fs.writeFile(publishedMarker, new Date().toISOString());

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
    const msg = error instanceof Error ? error.message : String(error);

    // Specific GitHub error messages
    if (msg.includes("401") || msg.includes("expired")) {
      return NextResponse.json({ ok: false, error: "Invalid or expired GitHub PAT" }, { status: 400 });
    }
    if (msg.includes("name already exists")) {
      return NextResponse.json({ ok: false, error: "Repository name already exists" }, { status: 409 });
    }

    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Publish failed", details: msg },
      { status: 500 },
    );
  }
}

async function createAndPushRepo(projectDir: string, repoName: string, githubPat: string, owner: string): Promise<string> {
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
          throw new Error("A repository with this name already exists.");
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("name already exists")) throw e;
      }
    }
    throw new Error(`GitHub repo creation failed (${createRes.status}): ${errorText}`);
  }

  const repo = (await createRes.json()) as { html_url: string; clone_url: string };
  const pushUrl = repo.clone_url.replace("https://", `https://${githubPat}@`);

  const git = (args: string[], timeoutMs = 10_000) =>
    runCommand("git", args, { cwd: projectDir, timeoutMs });

  // Remove forge metadata before committing
  await fs.rm(path.join(projectDir, ".forge-meta.json"), { force: true }).catch(() => {});
  await fs.rm(path.join(projectDir, ".forge-published"), { force: true }).catch(() => {});

  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "forge@project-forge.dev"]);
  await git(["config", "user.name", "project-forge"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "feat: initial scaffold\n\nGenerated with project-forge\nPlanned with agent-planforge · Scaffolded with scaffoldkit"]);
  await git(["remote", "add", "origin", pushUrl]);
  await git(["push", "-u", "origin", "main"], 30_000);

  return repo.html_url;
}
