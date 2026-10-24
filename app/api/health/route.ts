import { NextResponse } from "next/server";

// Liveness probe for the compose healthcheck. Public (the middleware matcher
// does not cover /api/health) and deliberately free of database or upstream
// calls: it answers "is the Node process serving requests", nothing more.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
