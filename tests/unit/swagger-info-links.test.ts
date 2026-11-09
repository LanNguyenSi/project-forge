import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The /docs info block recolours its links to the body text colour, so colour
// alone no longer marks them as links (WCAG 1.4.1). happy-dom does not apply
// the stylesheet, so this pins the rule text.
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

describe("swagger-ui info block links", () => {
  it("underlines the links that share the muted body colour", () => {
    const rule = css.match(/\.swagger-ui \.info a\s*\{([^}]*)\}/g) ?? [];
    const decl = rule.join("\n");
    expect(decl).toMatch(/text-decoration:\s*underline\s*!important/);
    // the colour override stays
    expect(css).toMatch(/\.swagger-ui \.info a\s*\{\s*color:\s*var\(--text-muted\)\s*!important/);
  });
});
