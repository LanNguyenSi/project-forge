// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The documented setup copies two files that carry secrets: `.env` (generated
 * `NEXTAUTH_SECRET`, service tokens) and `docker-compose.override.yml`
 * (`NEXTAUTH_SECRET`). The templates are world-readable, as any committed file
 * is, and a plain `cp` gives the copy that mode, so every documented copy is
 * followed by `chmod 600`. This pins the documented procedure: a copy added
 * without the mode step fails here. (`make dev-env` needs no step, its recipe
 * runs under `umask 077`; tests/integration/make-dev-env.test.ts pins that.)
 */

const root = path.resolve(__dirname, "../..");
const read = (f: string) => readFileSync(path.join(root, f), "utf-8");

const SECRET_TEMPLATES = String.raw`(?:\.env\.example|docker-compose\.override\.example\.yml)`;

/** The body of every fenced code block in a Markdown file. */
function codeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (current) blocks.push(current.join("\n"));
      current = current ? null : [];
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

/** Destinations of a documented copy of one of the secret templates. */
const copiedTo = (block: string) =>
  [...block.matchAll(new RegExp(String.raw`^cp ${SECRET_TEMPLATES}\s+(\S+)`, "gm"))].map((m) => m[1]);

/** Does a `chmod 600` line of the same block name this destination exactly? */
const chmodCovers = (block: string, dest: string) =>
  block
    .split("\n")
    .some((l) => l.trim().startsWith("chmod 600 ") && l.trim().split(/\s+/).slice(1).includes(dest));

describe("documented secret file copies", () => {
  for (const file of ["README.md", "CONTRIBUTING.md", "docs/deployment.md"]) {
    it(`gives every copy of a secret template in ${file} its chmod 600`, () => {
      const found = codeBlocks(read(file)).flatMap((block) => copiedTo(block).map((dest) => [block, dest] as const));
      // A document whose copies were renamed away is a different procedure, and
      // this test should say so instead of passing on nothing.
      expect(found.length).toBeGreaterThan(0);
      for (const [block, dest] of found) {
        expect(chmodCovers(block, dest), `${file}: cp to ${dest} has no chmod 600`).toBe(true);
      }
    });
  }

  it("names the strict mode next to the reason in every one of those documents", () => {
    for (const file of ["README.md", "CONTRIBUTING.md", "docs/deployment.md"]) {
      expect(read(file), file).toMatch(/chmod 600/);
    }
  });
});
