import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma, createApiToken } from "@/lib/db";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { name } = await req.json();

    if (!name || !name.trim()) {
      return NextResponse.json({ error: "Token name is required" }, { status: 400 });
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
    return NextResponse.json(
      { error: "Failed to create token", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
