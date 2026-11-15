// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Oversized-body coverage for the two auth routes (both unauthenticated,
 * so the byte cap is the only thing standing between an anonymous
 * caller and an unbounded req.json() buffer).
 */

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
    createApiToken: vi.fn(),
  };
});

vi.mock("@/lib/github", () => ({
  fetchGitHubUser: vi.fn(),
  GitHubAuthError: class GitHubAuthError extends Error {},
  GitHubUnreachableError: class GitHubUnreachableError extends Error {},
}));

import { prisma } from "@/lib/db";
import { fetchGitHubUser } from "@/lib/github";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as registerFromPilot } from "@/app/api/auth/register-from-project-pilot/route";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";

const user = prisma.user as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};
const mFetchGitHubUser = vi.mocked(fetchGitHubUser);

// Comfortably over DEFAULT_MAX_BODY_BYTES (64 KiB).
function bigBody(): string {
  return JSON.stringify({ email: "a@b.com", password: "x".repeat(DEFAULT_MAX_BODY_BYTES * 2) });
}

function req(url: string, body: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/auth/register body cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("413 on an oversized body, in the { ok, error } shape, before any DB call", async () => {
    const res = await register(req("http://test/api/auth/register", bigBody()));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/too large/i);
    expect(user.findUnique).not.toHaveBeenCalled();
    expect(user.create).not.toHaveBeenCalled();
  });

  it("a lying small Content-Length still gets 413 (streamed check)", async () => {
    const res = await register(
      new NextRequest("http://test/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "10" },
        body: bigBody(),
      })
    );
    expect(res.status).toBe(413);
    expect(user.create).not.toHaveBeenCalled();
  });

  it("keeps answering invalid JSON with the pre-existing 500", async () => {
    const res = await register(req("http://test/api/auth/register", "{not json"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/registration failed/i);
  });

  it("still accepts a small valid-shaped body (proceeds to field validation)", async () => {
    const res = await register(req("http://test/api/auth/register", JSON.stringify({})));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/register-from-project-pilot body cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("413 on an oversized body with the route's error-code shape, before GitHub is called", async () => {
    const res = await registerFromPilot(
      req("http://test/api/auth/register-from-project-pilot", bigBody())
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toMatch(/limit/i);
    expect(mFetchGitHubUser).not.toHaveBeenCalled();
  });

  it("keeps answering invalid JSON with the pre-existing 400 bad_request", async () => {
    const res = await registerFromPilot(req("http://test/api/auth/register-from-project-pilot", "{oops"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });
});
