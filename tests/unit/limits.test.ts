import { describe, expect, it } from "vitest";
import {
  AI_ASSIST_MAX_BODY_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  FILE_MODE_MAX_CHARS,
  GENERATE_MAX_BODY_BYTES,
  MAX_ATTACHMENT_CHARS,
  MAX_ATTACHMENT_TOTAL_CHARS,
  MAX_ATTACHMENTS,
  PROMPT_MODE_MAX_CHARS,
  attachmentLimitError,
} from "@/lib/limits";

function attachment(chars: number, name = "doc.md") {
  return { name, mimeType: "text/markdown", tier: "text" as const, inlineText: "x".repeat(chars) };
}

describe("lib/limits constants", () => {
  it("pins the attachment caps the UI enforces", () => {
    expect(MAX_ATTACHMENT_CHARS).toBe(50_000);
    expect(MAX_ATTACHMENT_TOTAL_CHARS).toBe(50_000);
    expect(MAX_ATTACHMENTS).toBe(1);
  });

  it("pins the ai-assist content caps", () => {
    expect(FILE_MODE_MAX_CHARS).toBe(50_000);
    expect(PROMPT_MODE_MAX_CHARS).toBe(10_000);
  });

  it("pins the default body cap", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it("derives the ai-assist body cap from the content caps (50k + 10k + 200 chars * 6 bytes + 512)", () => {
    expect(AI_ASSIST_MAX_BODY_BYTES).toBe((50_000 + 10_000 + 200) * 6 + 512);
  });

  it("derives the generate body cap from the attachment and text caps (50k + 200 + 50k chars * 6 bytes + 512)", () => {
    expect(GENERATE_MAX_BODY_BYTES).toBe((50_000 + 200 + 50_000) * 6 + 512);
  });
});

describe("attachmentLimitError", () => {
  it("returns null for undefined, null and non-array values", () => {
    expect(attachmentLimitError(undefined)).toBeNull();
    expect(attachmentLimitError(null)).toBeNull();
    expect(attachmentLimitError({ name: "x" })).toBeNull();
  });

  it("returns null for an empty array and for in-budget attachments", () => {
    expect(attachmentLimitError([])).toBeNull();
    expect(attachmentLimitError([attachment(1_000)])).toBeNull();
  });

  it("accepts a single file at exactly the per-file cap (boundary)", () => {
    expect(attachmentLimitError([attachment(MAX_ATTACHMENT_CHARS)])).toBeNull();
  });

  it("rejects one char over the per-file cap, naming the per-file limit", () => {
    const err = attachmentLimitError([attachment(MAX_ATTACHMENT_CHARS + 1, "huge.md")]);
    expect(err).toMatch(/per file/i);
    expect(err).toMatch(/50,001/);
    expect(err).toContain("huge.md");
  });

  it("rejects two mid-size files that together exceed the total, naming the total limit", () => {
    // 30k + 30k: each file passes per-file, together they pass nothing
    // else — the total check is the binding one.
    const err = attachmentLimitError([attachment(30_000), attachment(30_000)]);
    expect(err).toMatch(/total/i);
    expect(err).toMatch(/60,000/);
  });

  it("accepts exactly the count limit's worth of in-budget files…", () => {
    // One file is within count, per-file and total.
    expect(attachmentLimitError([attachment(20_000)])).toBeNull();
  });

  it("rejects more files than the count limit when each is individually in budget", () => {
    // 2 x 20k: per-file passes, total (40k) passes, only count fails.
    const err = attachmentLimitError([attachment(20_000), attachment(20_000)]);
    expect(err).toMatch(/too many attachments/i);
  });

  it("treats a missing or non-string inlineText as empty", () => {
    expect(attachmentLimitError([{ name: "a.md", mimeType: "text/markdown", tier: "text" }])).toBeNull();
    expect(attachmentLimitError([{ name: "a.md", mimeType: "text/markdown", tier: "text", inlineText: 42 }])).toBeNull();
  });
});
