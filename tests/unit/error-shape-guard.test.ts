import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Mechanical guard: every `NextResponse.json({ ... error: ... })` call under
 * app/api/** must also carry `ok: false` in the same response-body object
 * literal, per lib/types.ts ErrorResponse (`{ ok: false, error, details? }`).
 *
 * This is a structural check, not a route-behavior test: it walks every
 * app/api/**\/*.ts source file, finds each `NextResponse.json(...)` call
 * site (including the `NextResponse.json<T>(...)` generic form), and for
 * any call whose first-argument object literal contains an `error:` key,
 * asserts that same object literal also contains `ok: false`. It does NOT
 * attempt to evaluate the code — a fresh error response added later without
 * `ok: false` will fail this test even before any specific route test
 * catches it.
 */

const API_ROOT = path.resolve(__dirname, "../../app/api");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extracts the balanced `{ ... }` object-literal text starting at
 * `content[startBraceIndex]` (which must be `{`), respecting nested braces
 * and string/template literals so a `}` or `{` inside a string doesn't
 * throw off the depth count.
 */
function extractBalancedObject(content: string, startBraceIndex: number): string {
  let depth = 0;
  let i = startBraceIndex;
  let inString: '"' | "'" | "`" | null = null;
  for (; i < content.length; i++) {
    const ch = content[i];
    const prev = content[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch as '"' | "'" | "`";
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(startBraceIndex, i + 1);
    }
  }
  throw new Error(`Unbalanced object literal starting at index ${startBraceIndex}`);
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function findViolations(file: string): Violation[] {
  const content = fs.readFileSync(file, "utf-8");
  const callRe = /NextResponse\.json(?:<[^>]*>)?\(/g;
  const violations: Violation[] = [];
  let match: RegExpExecArray | null;

  while ((match = callRe.exec(content)) !== null) {
    // Find the first non-whitespace char after the call's opening paren.
    let cursor = match.index + match[0].length;
    while (cursor < content.length && /\s/.test(content[cursor])) cursor++;
    if (content[cursor] !== "{") {
      // Not an inline object literal (e.g. `NextResponse.json(response)`
      // or `NextResponse.json({ ok: true })`-style variable) — skip; this
      // guard only checks statically-visible error shapes.
      continue;
    }

    const objectText = extractBalancedObject(content, cursor);
    const hasError = /(^|[{,\s])error\s*:/.test(objectText);
    if (!hasError) continue;

    const hasOkFalse = /\bok\s*:\s*false\b/.test(objectText);
    if (!hasOkFalse) {
      const line = content.slice(0, match.index).split("\n").length;
      violations.push({ file, line, snippet: objectText.slice(0, 120).replace(/\s+/g, " ") });
    }
  }

  return violations;
}

describe("app/api error responses carry ok:false", () => {
  it("every NextResponse.json({ ...error... }) call also sets ok:false", () => {
    const files = walk(API_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(findViolations);

    if (violations.length > 0) {
      const report = violations
        .map((v) => `${path.relative(process.cwd(), v.file)}:${v.line}  ${v.snippet}`)
        .join("\n");
      throw new Error(`Found error response(s) without ok:false:\n${report}`);
    }

    expect(violations).toEqual([]);
  });
});
