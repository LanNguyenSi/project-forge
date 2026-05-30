import { describe, expect, it } from "vitest";
import { POST as legacyPublish } from "@/app/api/publish/route";
import { NextRequest } from "next/server";

describe("legacy POST /api/publish — path traversal guard", () => {
  it("rejects a traversal sessionId with 400 before touching the filesystem", async () => {
    const res = await legacyPublish(
      new NextRequest("http://test/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "../../etc", projectName: "demo" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid sessionId");
  });
});
