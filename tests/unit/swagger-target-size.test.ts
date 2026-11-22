import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// swagger-ui is third-party markup, so its target sizes are set from our own
// stylesheet; jsdom has no layout, so the rules themselves are pinned here and
// the rendered sizes are checked in a real browser.
const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

function declarationsOf(selector: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) blocks.push(m[1]);
  return blocks;
}

describe("swagger-ui target sizes", () => {
  it("gives operation rows a 44 px minimum height", () => {
    const blocks = declarationsOf(".swagger-ui .opblock .opblock-summary");
    expect(blocks.some((b) => /min-height:\s*44px/.test(b))).toBe(true);
  });

  it("gives the Authorize and lock buttons a 44 px minimum height", () => {
    const blocks = declarationsOf(".swagger-ui .btn.authorize");
    expect(blocks.some((b) => /min-height:\s*44px/.test(b))).toBe(true);
  });

  it("gives the lock button a 44 px minimum width", () => {
    const blocks = declarationsOf(".swagger-ui .authorization__btn");
    expect(blocks.some((b) => /min-width:\s*44px/.test(b))).toBe(true);
  });
});
