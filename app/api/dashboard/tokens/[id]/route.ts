import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Verify token belongs to user
    const token = await prisma.apiToken.findFirst({
      where: {
        id: id,
        userId: session.user.id,
      },
    });

    if (!token) {
      return NextResponse.json({ ok: false, error: "Token not found" }, { status: 404 });
    }

    await prisma.apiToken.update({
      where: { id: id },
      data: { revokedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { ok: false, error: "Failed to revoke token", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
