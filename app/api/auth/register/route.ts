import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { internalErrorDetails } from "@/lib/server-error";
import { readJsonBody, BodyTooLargeError } from "@/lib/read-json-body";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";
import { clientAddressFromHeaders, takeRegisterAttempt } from "@/lib/register-rate-limit";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = (await readJsonBody(req, DEFAULT_MAX_BODY_BYTES)) as {
      email?: string;
      password?: string;
    };

    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email and password are required" },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { ok: false, error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Placeholder addresses like `github-<id>@noreply` are reserved for the
    // GitHub sign-in (lib/auth.ts). Registering one first would lock that
    // sign-in out, so refuse them here. The domain check is after trimming
    // and case-insensitive, and covers any domain ending in `noreply`.
    const trimmedEmail = email.trim();
    const at = trimmedEmail.indexOf("@");
    const domain = at === -1 ? "" : trimmedEmail.slice(at + 1).toLowerCase();
    if (domain.endsWith("noreply")) {
      return NextResponse.json(
        { ok: false, error: "This email address cannot be used for registration" },
        { status: 400 }
      );
    }

    // Per-address attempt limit (lib/register-rate-limit.ts), taken after the
    // cheap 400 checks above and BEFORE the database lookup and bcrypt, so a
    // caller over the limit costs neither. Successful registrations count too.
    const address = clientAddressFromHeaders({
      "x-forwarded-for": req.headers.get("x-forwarded-for"),
    });
    if (!takeRegisterAttempt(address)) {
      return NextResponse.json(
        { ok: false, error: "Too many registration attempts, try again later" },
        { status: 429 }
      );
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return NextResponse.json(
        { ok: false, error: "User with this email already exists" },
        { status: 400 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error: unknown) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json(
        { ok: false, error: "Request body too large" },
        { status: 413 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "Registration failed", details: internalErrorDetails("Registration error", error) },
      { status: 500 }
    );
  }
}
