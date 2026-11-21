// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { findUnique, create, hash } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  hash: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique, create } } }));
vi.mock("bcryptjs", () => ({ default: { hash } }));

import { POST } from "@/app/api/auth/register/route";
import {
  REGISTER_MAX_ATTEMPTS,
  REGISTER_WINDOW_MS,
  resetRegisterLimiter,
} from "@/lib/register-rate-limit";

const ADDR = "203.0.113.9";

function makeReq(body: unknown, xff?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (xff !== undefined) headers["x-forwarded-for"] = xff;
  return new NextRequest("http://test/api/auth/register", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const via = (address: string, spoofed = "6.6.6.6") => `${spoofed}, ${address}`;
const at = (i: number) => ({ email: `u${i}@example.com`, password: "validpass" });

async function expectRegistered(res: Response) {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  resetRegisterLimiter();
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  create.mockImplementation(async ({ data }: { data: { email: string } }) => ({
    id: `id-${data.email}`,
    email: data.email,
  }));
  hash.mockResolvedValue("$2b$10$fakehash");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/auth/register rate limit", () => {
  it("serves attempts up to the limit from one address and 429s the next, with the { ok, error } shape", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await expectRegistered(await POST(makeReq(at(i), via(ADDR))));
    }
    const res = await POST(makeReq(at(99), via(ADDR)));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "Too many registration attempts, try again later" });
  });

  it("the attempt over the limit runs neither the database nor bcrypt", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await POST(makeReq(at(i), via(ADDR)));
    }
    findUnique.mockClear();
    create.mockClear();
    hash.mockClear();

    const res = await POST(makeReq(at(99), via(ADDR)));
    expect(res.status).toBe(429);
    expect(findUnique).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("successful registrations count too: 5 successes use up the whole budget", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await expectRegistered(await POST(makeReq(at(i), via(ADDR))));
    }
    expect(hash).toHaveBeenCalledTimes(REGISTER_MAX_ATTEMPTS);
    expect((await POST(makeReq(at(99), via(ADDR)))).status).toBe(429);
  });

  it("another address is unaffected by a used-up one", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await POST(makeReq(at(i), via(ADDR)));
    }
    await expectRegistered(await POST(makeReq(at(99), via("203.0.113.10"))));
  });

  it("the right-most X-Forwarded-Entry is the key: spoofed left entries do not change it", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      // A different forged left-hand entry on every request; the last entry is constant.
      await POST(makeReq(at(i), via(ADDR, `9.9.9.${i}`)));
    }
    // Same last entry, another forged prefix: still the same counter, still 429.
    expect((await POST(makeReq(at(99), via(ADDR, "1.2.3.4")))).status).toBe(429);
    // A different last entry: a different counter.
    await expectRegistered(await POST(makeReq(at(98), via("203.0.113.11", "1.2.3.4"))));
  });

  it("a single-entry X-Forwarded-For is the address", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await POST(makeReq(at(i), ADDR));
    }
    expect((await POST(makeReq(at(99), ADDR))).status).toBe(429);
    await expectRegistered(await POST(makeReq(at(98), "203.0.113.10")));
  });

  it("requests without a usable address share one fallback counter", async () => {
    // No header at all; time moves between requests so the key cannot depend on it.
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await POST(makeReq(at(i)));
      vi.advanceTimersByTime(1);
    }
    expect((await POST(makeReq(at(99)))).status).toBe(429);
    // An XFF header whose last entry is not an IP is just as unusable: same key.
    expect((await POST(makeReq(at(98), "1.1.1.1, not-an-ip"))).status).toBe(429);
    // A real address is unaffected.
    await expectRegistered(await POST(makeReq(at(97), via(ADDR))));
  });

  it("literal limits: 5 pass, the 6th is 429 until exactly one hour after the first", async () => {
    for (let i = 0; i < 5; i++) {
      await expectRegistered(await POST(makeReq(at(i), via(ADDR))));
    }
    expect((await POST(makeReq(at(5), via(ADDR)))).status).toBe(429);
    vi.advanceTimersByTime(3_600_000 - 1);
    expect((await POST(makeReq(at(6), via(ADDR)))).status).toBe(429);
    vi.advanceTimersByTime(1);
    await expectRegistered(await POST(makeReq(at(7), via(ADDR))));
  });

  it("the 400 validations run first and consume nothing", async () => {
    const invalid: Array<Record<string, string>> = [
      {},
      { password: "validpass" },
      { email: "a@b.com" },
      { email: "a@b.com", password: "short" },
      { email: "github-1001@noreply", password: "validpass" },
    ];
    for (let i = 0; i < 4; i++) {
      for (const body of invalid) {
        expect((await POST(makeReq(body, via(ADDR)))).status).toBe(400);
      }
    }
    // None of the 20 refused bodies touched the register counter.
    await expectRegistered(await POST(makeReq(at(0), via(ADDR))));
  });

  it("attempts are allowed again after the window, and a refused attempt does not extend it", async () => {
    for (let i = 0; i < REGISTER_MAX_ATTEMPTS; i++) {
      await POST(makeReq(at(i), via(ADDR)));
    }
    vi.advanceTimersByTime(REGISTER_WINDOW_MS - 1);
    expect((await POST(makeReq(at(99), via(ADDR)))).status).toBe(429);
    vi.advanceTimersByTime(1);
    await expectRegistered(await POST(makeReq(at(99), via(ADDR))));
  });

  it("an existing-email 400 still counted its attempt, and an unchanged 200 stays a 200", async () => {
    findUnique.mockResolvedValue({ id: "dup", email: "u0@example.com" });
    expect((await POST(makeReq(at(0), via(ADDR)))).status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
    for (let i = 1; i < REGISTER_MAX_ATTEMPTS; i++) {
      expect((await POST(makeReq(at(i), via(ADDR)))).status).toBe(400);
    }
    // 5 counted attempts (the duplicate 400 included): the next is refused.
    expect((await POST(makeReq(at(99), via(ADDR)))).status).toBe(429);
  });
});
