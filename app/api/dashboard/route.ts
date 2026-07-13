import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      apiTokens: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      githubPatConnected: !!user.githubPat,
    },
    tokens: user.apiTokens.map((t) => ({
      id: t.id,
      name: t.name,
      token: t.token,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
    })),
  });
}
