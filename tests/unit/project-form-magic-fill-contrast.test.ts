// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * text-forge-ash (#8a93a0) is 4.25:1 on the amber-tinted Magic Fill panel,
 * below the 4.5:1 axe color-contrast threshold. The panel text must use a
 * lighter token; this is a source check because the contrast depends on the
 * panel background, not on anything jsdom computes.
 */
const source = readFileSync(new URL("../../components/ProjectForm.tsx", import.meta.url), "utf-8");

function classNameOfOpeningTagContaining(marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.lastIndexOf("<", at);
  const close = source.indexOf(">", at);
  const tag = source.slice(open, close);
  const match = tag.match(/className="([^"]*)"/);
  if (!match) throw new Error(`no className on tag with ${marker}`);
  return match[1];
}

describe("ProjectForm Magic Fill text contrast", () => {
  it("does not style the prompt counter with text-forge-ash", () => {
    const cls = classNameOfOpeningTagContaining('id="magic-prompt-counter"');
    expect(cls).not.toContain("text-forge-ash");
  });

  it("does not style the description paragraph with text-forge-ash", () => {
    const cls = classNameOfOpeningTagContaining("Seed the form with a one-line prompt");
    expect(cls).not.toContain("text-forge-ash");
  });
});
