import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

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

  // /dashboard/* — requires session
  if (pathname.startsWith("/dashboard")) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/v1/:path*", "/dashboard/:path*"],
};
