import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

// The origin the client used for this request. req.url is not reliable for
// that: `next start -H 127.0.0.1` makes it http://localhost:<port> whatever
// the Host header says, so a redirect built from it sent the browser to
// another host, where the host-only session cookies are not present. The host
// follows NextAuth's own detection when it trusts the request (X-Forwarded-Host
// before Host, first value of a list); the protocol is the one Next derived
// (it honours X-Forwarded-Proto). Next shortens a Location whose origin equals
// its own to a relative one, so the usual case still answers `/login?...`. A
// host that does not parse as a bare host[:port] falls back to req.url.
function clientOrigin(req: NextRequest): string {
  const first = (value: string | null) => value?.split(",")[0]?.trim() ?? "";
  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host"));
  try {
    const origin = new URL(`${req.nextUrl.protocol}//${host}`);
    if (!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash) {
      return origin.origin;
    }
  } catch {
    // unparsable host: fall through
  }
  return req.nextUrl.origin;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /api/v1/* — validated via X-API-Key header in each route (not session)
  if (pathname.startsWith("/api/v1/")) {
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Missing X-API-Key header" }, { status: 401 });
    }
    // Token validation happens inside each route (needs DB access)
    return NextResponse.next();
  }

  // Protected pages — require session
  const protectedPaths = ["/dashboard", "/create", "/settings"];
  if (protectedPaths.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      const callbackUrl = pathname + req.nextUrl.search;
      const loginUrl = new URL("/login", clientOrigin(req));
      loginUrl.searchParams.set("callbackUrl", callbackUrl);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/v1/:path*", "/dashboard/:path*", "/create/:path*", "/settings/:path*"],
};
