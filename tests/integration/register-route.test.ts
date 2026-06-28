import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    },
  };
});

import { prisma } from "@/lib/db";
import { POST } from "@/app/api/auth/register/route";

const user = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("400 when body is empty (no email and no password)", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
    expect(user.findUnique).not.toHaveBeenCalled();
    expect(user.create).not.toHaveBeenCalled();
  });

  it("400 when email is missing", async () => {
    const res = await POST(makeReq({ password: "securepass" }));
    expect(res.status).toBe(400);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("400 when password is missing", async () => {
    const res = await POST(makeReq({ email: "a@b.com" }));
    expect(res.status).toBe(400);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("400 when password is shorter than 8 characters", async () => {
    const res = await POST(makeReq({ email: "a@b.com", password: "short" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/8/);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("400 when password is exactly 7 characters (boundary)", async () => {
    const res = await POST(makeReq({ email: "a@b.com", password: "1234567" }));
    expect(res.status).toBe(400);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("400 when email already exists (duplicate user)", async () => {
    user.findUnique.mockResolvedValue({
      id: "existing-user",
      email: "already@example.com",
    });
    const res = await POST(makeReq({ email: "already@example.com", password: "validpass" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("200 on success with password length exactly 8 (boundary)", async () => {
    user.findUnique.mockResolvedValue(null);
    user.create.mockResolvedValue({ id: "new-user", email: "new@example.com" });

    const res = await POST(makeReq({ email: "new@example.com", password: "12345678" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe("new-user");
    expect(body.user.email).toBe("new@example.com");
  });

  it("stores a bcrypt hash, NOT the raw password, on create", async () => {
    const rawPassword = "mySecurePass99";
    user.findUnique.mockResolvedValue(null);
    user.create.mockResolvedValue({ id: "u1", email: "u@test.com" });

    await POST(makeReq({ email: "u@test.com", password: rawPassword }));

    expect(user.create).toHaveBeenCalledTimes(1);
    const createArg = user.create.mock.calls[0][0];
    // Must be hashed — not equal to raw
    expect(createArg.data.passwordHash).not.toBe(rawPassword);
    // bcryptjs produces $2a$ hashes (equivalent security to $2b$)
    expect(createArg.data.passwordHash).toMatch(/^\$2[ab]\$/);
    // Raw password must not appear anywhere in the create args
    expect(JSON.stringify(createArg)).not.toContain(rawPassword);
  });

  it("response body never echoes the raw password on success", async () => {
    const rawPassword = "superSecret42";
    user.findUnique.mockResolvedValue(null);
    user.create.mockResolvedValue({ id: "u2", email: "u2@test.com" });

    const res = await POST(makeReq({ email: "u2@test.com", password: rawPassword }));
    const text = await res.text();
    expect(text).not.toContain(rawPassword);
  });

  it("response body never echoes the raw password on 400 duplicate-email error", async () => {
    const rawPassword = "secretPass123";
    user.findUnique.mockResolvedValue({ id: "existing", email: "dup@example.com" });

    const res = await POST(makeReq({ email: "dup@example.com", password: rawPassword }));
    const text = await res.text();
    expect(text).not.toContain(rawPassword);
  });

  it("500 when an unexpected DB error is thrown during user creation", async () => {
    user.findUnique.mockResolvedValue(null);
    user.create.mockRejectedValue(new Error("DB connection lost unexpectedly"));

    const res = await POST(makeReq({ email: "x@test.com", password: "validpass!" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/registration failed/i);
  });
});
