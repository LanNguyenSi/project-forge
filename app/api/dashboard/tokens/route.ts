import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma, generateApiToken } from "@/lib/db";

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

    const token = generateApiToken();

    const apiToken = await prisma.apiToken.create({
      data: {
        token,
        name: name.trim(),
        userId: session.user.id,
      },
    });

    return NextResponse.json({
      ok: true,
      token: {
        id: apiToken.id,
        name: apiToken.name,
        token: apiToken.token,
        createdAt: apiToken.createdAt,
      },
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: "Failed to create token", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
