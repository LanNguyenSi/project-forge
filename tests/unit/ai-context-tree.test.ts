import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Mechanical guard: the `lib/` and `components/` blocks of the structure
 * tree in AI_CONTEXT.md must list exactly the files that exist on disk
 * (docs/architecture.md: "docs track the code"). The tree drifted twice
 * before; this test makes a third drift fail CI instead of a report.
 *
 * How the blocks are found: the tree is the fenced block at the top of
 * AI_CONTEXT.md. A block starts at the top-level entry line for the
 * directory (a line whose very first character is `├── ` or `└── `, so
 * nested entries -- which sit behind `│` columns -- can never be
 * mistaken for it, e.g. `├── lib/`) and runs until the next top-level
 * entry line or a line outside the tree (the closing fence or prose).
 * Entry names are the text between the `── ` prefix and the `#` comment
 * column; entries ending in `/` are directories and skipped, entries
 * ending in `.ts`/`.tsx` are collected. A missing block header fails
 * the test outright -- it is never treated as an empty (passing) block.
 *
 * Real files: `lib/` = the `.ts` files directly in `lib/` (no
 * recursion); `components/` = every `.ts`/`.tsx` file under
 * `components/`, recursively. Comparison is by file name (the tree
 * shows nested files as `layout/AppShell.tsx`, so only the last path
 * segment is compared; the repository has no name collisions).
 */

const ROOT = path.resolve(__dirname, "../..");
const AI_CONTEXT_PATH = path.join(ROOT, "AI_CONTEXT.md");

/** True for a line that opens or closes a top-level tree entry. */
function isTopLevelEntry(line: string): boolean {
  return /^[├└]── /.test(line);
}

/**
 * Returns the `.ts`/`.tsx` file names listed in the structure-tree block
 * for `dirName` ("lib" or "components"), or null when the block header
 * line is absent (the caller turns that into a failure, never a pass).
 */
function treeEntriesFor(content: string, dirName: string): string[] | null {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^[├└]── ${dirName}/(\\s+#.*)?$`);
  const header = lines.findIndex((line) => headerRe.test(line));
  if (header === -1) return null;
  const entries: string[] = [];
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isTopLevelEntry(line)) break; // next top-level entry: block ended
    if (!line.startsWith("│")) break; // lone column or outside the tree
    const parsed = /(?:├|└)── (.*)$/.exec(line);
    if (!parsed) continue; // subtree continuation without an entry (e.g. "│")
    const entry = parsed[1].split("#")[0].trim();
    if (!entry || entry.endsWith("/")) continue; // directory
    if (/\.tsx?$/.test(entry)) entries.push(path.basename(entry));
  }
  return entries;
}

/** File names on disk that the tree must list for `dirName`. */
function filesOnDiskFor(dirName: string): string[] {
  const dir = path.join(ROOT, dirName);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(entry.name);
      }
    }
  };
  if (dirName === "lib") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.ts$/.test(entry.name)) out.push(entry.name);
    }
    return out;
  }
  walk(dir);
  return out;
}

describe("AI_CONTEXT.md structure tree", () => {
  it("lists exactly the files of lib/ and components/ in the tree", () => {
    const content = fs.readFileSync(AI_CONTEXT_PATH, "utf8");
    const problems: string[] = [];

    for (const dirName of ["lib", "components"]) {
      const listed = treeEntriesFor(content, dirName);
      if (listed === null) {
        problems.push(
          `structure tree: no top-level "${dirName}/" block header found in AI_CONTEXT.md ` +
            `- the block was removed or its header renamed; restore it (the test never passes silently on a missing block)`
        );
        continue;
      }
      const onDisk = filesOnDiskFor(dirName);
      const missing = onDisk.filter((f) => !listed.includes(f)).sort();
      const ghost = listed.filter((f) => !onDisk.includes(f)).sort();
      if (missing.length > 0) {
        problems.push(
          `${dirName}/: ${missing.join(", ")} exist on disk but are not listed in the ` +
            `${dirName}/ block of the AI_CONTEXT.md structure tree - add them there with a short comment`
        );
      }
      if (ghost.length > 0) {
        problems.push(
          `${dirName}/: ${ghost.join(", ")} listed in the ${dirName}/ block of the ` +
            `AI_CONTEXT.md structure tree but no such file exists - fix or remove the entries`
        );
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });
});
