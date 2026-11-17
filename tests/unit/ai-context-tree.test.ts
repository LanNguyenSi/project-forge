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
 * column; entries ending in `/` are directories that open a nesting level,
 * entries ending in `.ts`/`.tsx` are collected with their directory path. A missing block header fails
 * the test outright -- it is never treated as an empty (passing) block.
 *
 * Real files: every `.ts`/`.tsx` file under `lib/` and `components/`,
 * recursively. Comparison is by path relative to the block's directory
 * (`ui/primitives/Button.tsx`), so two files with the same name in
 * different subdirectories each need their own entry.
 */

const ROOT = path.resolve(__dirname, "../..");
const AI_CONTEXT_PATH = path.join(ROOT, "AI_CONTEXT.md");

/** True for a line that opens or closes a top-level tree entry. */
function isTopLevelEntry(line: string): boolean {
  return /^[├└]── /.test(line);
}

/**
 * Returns the `.ts`/`.tsx` files listed in the structure-tree block for
 * `dirName` ("lib" or "components") as paths relative to that directory
 * (`layout/AppShell.tsx`), or null when the block header line is absent
 * (the caller turns that into a failure, never a pass). Nesting comes from
 * the indentation: every tree level is four characters (`│   ` or four
 * spaces) before the `├── `/`└── ` marker, and directory entries (ending in
 * `/`) open a level for the entries below them.
 */
function treeEntriesFor(content: string, dirName: string): string[] | null {
  const lines = content.split(/\r?\n/);
  const headerRe = new RegExp(`^[├└]── ${dirName}/(\\s+#.*)?$`);
  const header = lines.findIndex((line) => headerRe.test(line));
  if (header === -1) return null;
  const entries: string[] = [];
  const dirs: string[] = []; // dirs[d] = directory name opened at depth d (depth 1 = block child)
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isTopLevelEntry(line)) break; // next top-level entry: block ended
    if (!line.startsWith("│")) break; // lone column or outside the tree
    const parsed = /^(.*?)(?:├|└)── (.*)$/.exec(line);
    if (!parsed) continue; // subtree continuation without an entry (e.g. "│")
    const depth = parsed[1].length / 4;
    const entry = parsed[2].split("#")[0].trim();
    if (!entry) continue;
    dirs.length = depth; // drop directories of deeper or equal levels
    if (entry.endsWith("/")) {
      dirs[depth] = entry.slice(0, -1);
      continue;
    }
    if (/\.tsx?$/.test(entry)) {
      entries.push([...dirs.slice(1, depth), entry].join("/"));
    }
  }
  return entries;
}

/**
 * `.ts`/`.tsx` files on disk under `dirName`, recursively, as paths
 * relative to that directory. Recursing in `lib/` too means a file in a
 * new `lib/` subdirectory must be listed as well instead of being ignored.
 */
function filesOnDiskFor(dirName: string): string[] {
  const root = path.join(ROOT, dirName);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
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
