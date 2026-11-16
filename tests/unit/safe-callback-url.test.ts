import { describe, expect, it } from "vitest";
import { DEFAULT_CALLBACK_URL, safeCallbackUrl } from "@/lib/safe-callback-url";

describe("safeCallbackUrl accepts same-origin relative paths", () => {
  it("keeps /create", () => {
    expect(safeCallbackUrl("/create")).toBe("/create");
  });

  it("keeps /settings with a query", () => {
    expect(safeCallbackUrl("/settings?tab=tokens")).toBe("/settings?tab=tokens");
  });

  it("keeps a nested path with a fragment", () => {
    expect(safeCallbackUrl("/dashboard/projects/1#top")).toBe("/dashboard/projects/1#top");
  });

  it("keeps a percent-encoded query value that decodes to something harmless", () => {
    expect(safeCallbackUrl("/settings?next=%2Fcreate")).toBe("/settings?next=%2Fcreate");
  });
});

describe("safeCallbackUrl falls back to the dashboard", () => {
  it("is /dashboard", () => {
    expect(DEFAULT_CALLBACK_URL).toBe("/dashboard");
  });

  it("for an absent value (null)", () => {
    expect(safeCallbackUrl(null)).toBe("/dashboard");
  });

  it("for an absent value (undefined)", () => {
    expect(safeCallbackUrl(undefined)).toBe("/dashboard");
  });

  it("for an empty value", () => {
    expect(safeCallbackUrl("")).toBe("/dashboard");
  });

  it("for a protocol-relative URL", () => {
    expect(safeCallbackUrl("//evil.test")).toBe("/dashboard");
  });

  it("for a backslash after the slash", () => {
    expect(safeCallbackUrl("/\\evil.test")).toBe("/dashboard");
  });

  it("for an absolute https URL", () => {
    expect(safeCallbackUrl("https://evil.test")).toBe("/dashboard");
  });

  it("for a javascript: URL", () => {
    expect(safeCallbackUrl("javascript:alert(1)")).toBe("/dashboard");
  });

  it("for an encoded protocol-relative URL (starts with a percent sign)", () => {
    expect(safeCallbackUrl("%2F%2Fevil.test")).toBe("/dashboard");
  });

  it("for a value that only decodes to a protocol-relative URL", () => {
    expect(safeCallbackUrl("/%2Fevil.test")).toBe("/dashboard");
  });

  it("for a value that only decodes to a slash-backslash prefix", () => {
    expect(safeCallbackUrl("/%5Cevil.test")).toBe("/dashboard");
  });

  it("for a leading space", () => {
    expect(safeCallbackUrl(" /create")).toBe("/dashboard");
  });

  it("for a leading tab", () => {
    expect(safeCallbackUrl("\t/create")).toBe("/dashboard");
  });

  it("for a tab after the slash (URL parsers drop it, leaving //)", () => {
    expect(safeCallbackUrl("/\t/evil.test")).toBe("/dashboard");
  });

  it("for a newline inside the path", () => {
    expect(safeCallbackUrl("/create\nSet-Cookie: x=1")).toBe("/dashboard");
  });

  it("for a NUL byte", () => {
    expect(safeCallbackUrl("/create\u0000")).toBe("/dashboard");
  });

  it("for a DEL character", () => {
    expect(safeCallbackUrl("/create\u007f")).toBe("/dashboard");
  });

  it("for a control character that only appears after decoding", () => {
    expect(safeCallbackUrl("/create%0d%0aX")).toBe("/dashboard");
  });

  it("for a value that does not decode (lone percent sign)", () => {
    expect(safeCallbackUrl("/create%")).toBe("/dashboard");
  });

  it("for a bare relative path without a leading slash", () => {
    expect(safeCallbackUrl("create")).toBe("/dashboard");
  });
});
