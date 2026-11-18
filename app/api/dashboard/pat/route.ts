import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isStaleSession } from "@/lib/session-cutoff";
import { internalErrorDetails } from "@/lib/server-error";
import { readJsonBody, BodyTooLargeError } from "@/lib/read-json-body";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";
import { encryptGithubPat, readGithubPat } from "@/lib/github-pat";

// Settings-only: whether the caller has a usable GitHub token and what kind it
// is. The token itself is never returned to anyone; the settings page only
// replaces it (POST). `kind` is derived from the token prefix on the server
// (gho_ is the OAuth token from GitHub sign-in, anything else a manual PAT).
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, githubPat: true, sessionsValidAfter: true },
  });

  if (!user) {
    return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
  }

  // The cutoff comes from the same read as the token: a legacy row claimed
  // after getServerSession passed would otherwise hand the new owner's token to
  // the session that was open before the claim.
  if (isStaleSession(session.authAt, user.sessionsValidAfter)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // The column is encrypted; a value that does not decrypt counts as not
  // connected. Nothing derived from the token beyond the kind leaves here.
  const token = await readGithubPat(user);
  const kind: "oauth" | "manual" | null = token ? (token.startsWith("gho_") ? "oauth" : "manual") : null;
  return NextResponse.json(
    { ok: true, connected: token !== null, kind },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { githubPat } = (await readJsonBody(req, DEFAULT_MAX_BODY_BYTES)) as { githubPat?: string };

    if (!githubPat || !githubPat.startsWith("ghp_")) {
      return NextResponse.json(
        { ok: false, error: "Invalid GitHub PAT format" },
        { status: 400 }
      );
    }

    // The write carries the cutoff test itself, so a claim that commits after
    // the session check cannot have its token overwritten by an older session
    // (update throws P2025 when no row matches).
    await prisma.user.update({
      where: {
        id: session.user.id,
        OR: [
          { sessionsValidAfter: null },
          ...(typeof session.authAt === "number" ? [{ sessionsValidAfter: { lte: new Date(session.authAt) } }] : []),
        ],
      },
      data: { githubPat: encryptGithubPat(githubPat) },
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ ok: false, error: "Request body too large" }, { status: 413 });
    }
    if ((error as { code?: unknown } | null)?.code === "P2025") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { ok: false, error: "Failed to save PAT", details: internalErrorDetails("Save PAT failed", error) },
      { status: 500 }
    );
  }
}
