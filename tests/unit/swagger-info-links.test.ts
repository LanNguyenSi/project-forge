import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The /docs info block recolours its links to the body text colour, so colour
// alone no longer marks them as links (WCAG 1.4.1). happy-dom does not apply
// the stylesheet, so this pins the rule text.
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

describe("swagger-ui info block links", () => {
  // every declaration inside any block whose selector list includes `.swagger-ui .info a`
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = [...withoutComments.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.split(",").some((sel) => sel.trim() === ".swagger-ui .info a"))
    .map(([, , body]) => body)
    .join("\n");

  it("underlines the links that share the muted body colour", () => {
    expect(declarations).toMatch(/text-decoration:\s*underline\s*!important/);
  });

  it("keeps the colour override", () => {
    expect(declarations).toMatch(/color:\s*var\(--text-muted\)\s*!important/);
  });
});
