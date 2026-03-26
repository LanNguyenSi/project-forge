import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Verify token belongs to user
    const token = await prisma.apiToken.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!token) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    await prisma.apiToken.update({
      where: { id: params.id },
      data: { revokedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: "Failed to revoke token", details: error.message },
      { status: 500 }
    );
  }
}
