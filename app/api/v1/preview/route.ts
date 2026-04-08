import { NextRequest, NextResponse } from "next/server";
import { validateApiToken } from "@/lib/db";
import * as fs from "fs/promises";
import * as path from "path";
import type { ErrorResponse } from "@/lib/types";
import { SESSION_UUID_RE, readForgeMeta, isSessionExpired, readPreviewData } from "@/lib/v1-shared";

const TEMP_ROOT = process.env.FORGE_TEMP_DIR ?? "/tmp/project-forge";

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
  }

  const tokenRecord = await validateApiToken(apiKey);
  if (!tokenRecord) {
    return NextResponse.json({ ok: false, error: "Invalid or revoked API token" }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId || !SESSION_UUID_RE.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "Missing or invalid sessionId" }, { status: 400 });
  }

  const tempDir = path.join(TEMP_ROOT, sessionId);

  try {
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

    const preview = await readPreviewData(tempDir, meta.projectName);

    return NextResponse.json({ ok: true, sessionId, preview });
  } catch (error: unknown) {
    console.error("Preview read failed:", error);
    return NextResponse.json<ErrorResponse>(
      { ok: false, error: "Failed to read preview" },
      { status: 500 },
    );
  }
}
