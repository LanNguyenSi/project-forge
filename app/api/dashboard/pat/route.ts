import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Settings-only: the caller's own raw GitHub PAT. The shared GET /api/dashboard
// response only exposes a `githubPatConnected` boolean (see app/api/dashboard/route.ts)
// because most consumers only need existence; the settings page pre-fills/edits
// the token and needs the raw value, scoped strictly to the authenticated owner.
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { githubPat: true },
  });

  if (!user) {
    return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
  }

  // Secret-bearing response: forbid any intermediary/browser caching.
  return NextResponse.json(
    { ok: true, githubPat: user.githubPat },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { githubPat } = await req.json();

    if (!githubPat || !githubPat.startsWith("ghp_")) {
      return NextResponse.json(
        { ok: false, error: "Invalid GitHub PAT format" },
        { status: 400 }
      );
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { githubPat },
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { ok: false, error: "Failed to save PAT", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
