import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * The signed-in user's recorded projects: usage rows with a repo URL that are
 * not soft-deleted. Same filter as GET /api/v1/projects, but session-authed.
 * A row with a NULL repoUrl is a reservation of a publish still in flight, not
 * a project yet. Publishes through the web form write no row, so they are not
 * listed here.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Clamp to 1-50 for any input (zero, negative, non-numeric, fractional).
  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Math.trunc(Math.max(1, Math.min(limitParam || DEFAULT_LIMIT, MAX_LIMIT)));

  const where = {
    userId: session.user.id,
    repoUrl: { not: null },
    deletedAt: null,
  };

  const [rows, total] = await Promise.all([
    prisma.usageLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, repoUrl: true, createdAt: true },
    }),
    prisma.usageLog.count({ where }),
  ]);

  return NextResponse.json({
    ok: true,
    projects: rows.map((p: { id: string; repoUrl: string | null; createdAt: Date }) => ({
      id: p.id,
      repoUrl: p.repoUrl ?? "",
      projectName: p.repoUrl?.split("/").pop() ?? "",
      createdAt: p.createdAt.toISOString(),
    })),
    total,
  });
}
