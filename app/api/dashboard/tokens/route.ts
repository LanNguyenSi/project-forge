import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma, createApiToken } from "@/lib/db";
import { internalErrorDetails } from "@/lib/server-error";
import { readJsonBody, BodyTooLargeError } from "@/lib/read-json-body";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { name } = (await readJsonBody(req, DEFAULT_MAX_BODY_BYTES)) as { name?: string };

    if (!name || !name.trim()) {
      return NextResponse.json({ ok: false, error: "Token name is required" }, { status: 400 });
    }

    // The raw token is returned here and ONLY here: it is never persisted
    // (only its hash is), so this response body is the one and only time
    // the caller can see it.
    const { raw, record } = await createApiToken(prisma, session.user.id, name.trim());

    return NextResponse.json({
      ok: true,
      token: {
        id: record.id,
        name: record.name,
        token: raw,
        createdAt: record.createdAt,
      },
    });
  } catch (error: unknown) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ ok: false, error: "Request body too large" }, { status: 413 });
    }
    return NextResponse.json(
      { ok: false, error: "Failed to create token", details: internalErrorDetails("Create token failed", error) },
      { status: 500 }
    );
  }
}
