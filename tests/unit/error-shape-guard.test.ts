import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Mechanical guard: every JSON error response constructed under app/api/**
 * (and middleware.ts, which builds v1 error responses too) must carry
 * `ok: false` in the same response-body object literal, per lib/types.ts
 * ErrorResponse (`{ ok: false, error, details? }`).
 *
 * This is a structural check, not a route-behavior test. It scans three
 * call shapes:
 *   1. `NextResponse.json({ ... })` / `NextResponse.json<T>({ ... })`
 *   2. `Response.json({ ... })` (the bare Fetch API constructor)
 *   3. `new NextResponse(JSON.stringify({ ... }), { status })`
 * and for any call whose body object literal contains an `error:` key,
 * asserts that same object literal also contains `ok: false`.
 *
 * It also flags a fourth, unverifiable shape: `NextResponse.json(<expr>, {
 * status: 4xx|5xx })` where the body is a variable or other expression
 * rather than an inline object literal. The guard cannot statically inspect
 * what such an expression contains, so pairing a non-literal body with a
 * literal error status is treated as a violation on its own -- the safe
 * fix is always an inline `{ ok: false, error, ... }` literal at the call
 * site (or a fully-typed helper whose return type is ErrorResponse).
 *
 * It does NOT attempt to evaluate the code -- a fresh error response added
 * later without `ok: false` will fail this test even before any specific
 * route test catches it.
 */

const API_ROOT = path.resolve(__dirname, "../../app/api");
const MIDDLEWARE_PATH = path.resolve(__dirname, "../../middleware.ts");

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
 * Extracts the text of a parenthesized call's arguments, given `content`
 * and the index of the first character after the call's opening `(`.
 * Respects nested parens and string/template literals so a `)` inside a
 * string can't end the scan early.
 */
function extractBalancedParenArgs(content: string, start: number): string {
  let depth = 1;
  let inString: '"' | "'" | "`" | null = null;
  for (let i = start; i < content.length; i++) {
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
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return content.slice(start, i);
    }
  }
  throw new Error(`Unbalanced parens starting at index ${start}`);
}

/**
 * Splits a call's argument text into top-level, comma-separated arguments,
 * respecting nested (), {}, [], and string/template literals.
 */
function splitTopLevelArgs(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let current = "";
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    const prev = argsText[i - 1];
    if (inString) {
      current += ch;
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "" || parts.length > 0) parts.push(current);
  return parts.map((p) => p.trim());
}

function objectLiteralHasUnsafeError(objectText: string): boolean {
  const hasError = /(^|[{,\s])error\s*:/.test(objectText);
  if (!hasError) return false;
  return !/\bok\s*:\s*false\b/.test(objectText);
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function findViolations(file: string): Violation[] {
  const content = fs.readFileSync(file, "utf-8");
  const violations: Violation[] = [];

  // --- NextResponse.json(...) / Response.json(...) -------------------------
  // The first alternative matches "NextResponse.json(" outright; the second
  // matches a bare "Response.json(" not already consumed as part of
  // "NextResponse.json(" (the lookbehind only excludes a literal "Next"
  // immediately before "Response", so it never fires inside a match already
  // claimed by the first alternative).
  const jsonCallRe = /NextResponse\.json(?:<[^>]*>)?\(|(?<!Next)Response\.json(?:<[^>]*>)?\(/g;
  let match: RegExpExecArray | null;
  while ((match = jsonCallRe.exec(content)) !== null) {
    const argsStart = match.index + match[0].length;
    const argsText = extractBalancedParenArgs(content, argsStart);
    const [bodyArg = "", optionsArg = ""] = splitTopLevelArgs(argsText);

    if (bodyArg.startsWith("{")) {
      if (objectLiteralHasUnsafeError(bodyArg)) {
        violations.push({ file, line: lineOf(content, match.index), snippet: bodyArg.slice(0, 120).replace(/\s+/g, " ") });
      }
      continue;
    }

    // Body is a variable or other expression, not an inline object literal
    // -- the guard cannot statically verify it carries ok:false. Flag it
    // whenever paired with a literal 4xx/5xx status: that combination is
    // exactly the "variable-held error body" shape an inline-object check
    // alone would miss.
    const statusMatch = optionsArg.match(/\bstatus\s*:\s*(\d{3})\b/);
    if (statusMatch) {
      const status = Number(statusMatch[1]);
      if (status >= 400 && status < 600) {
        violations.push({
          file,
          line: lineOf(content, match.index),
          snippet: `${bodyArg.slice(0, 60).replace(/\s+/g, " ")} (variable-held body, status ${status}, cannot verify ok:false statically)`,
        });
      }
    }
  }

  // --- new NextResponse(JSON.stringify({ ... }), { status }) ---------------
  const rawCtorRe = /new\s+NextResponse\(/g;
  while ((match = rawCtorRe.exec(content)) !== null) {
    const argsStart = match.index + match[0].length;
    const argsText = extractBalancedParenArgs(content, argsStart);
    const [bodyArg = "", optionsArg = ""] = splitTopLevelArgs(argsText);

    const stringifyPrefix = bodyArg.match(/^JSON\.stringify\(/);
    if (!stringifyPrefix) continue;

    const innerStart = stringifyPrefix[0].length;
    const innerArgsText = extractBalancedParenArgs(bodyArg, innerStart);
    const [innerBody = ""] = splitTopLevelArgs(innerArgsText);

    if (innerBody.startsWith("{")) {
      if (objectLiteralHasUnsafeError(innerBody)) {
        violations.push({ file, line: lineOf(content, match.index), snippet: innerBody.slice(0, 120).replace(/\s+/g, " ") });
      }
      continue;
    }

    const statusMatch = optionsArg.match(/\bstatus\s*:\s*(\d{3})\b/);
    if (statusMatch) {
      const status = Number(statusMatch[1]);
      if (status >= 400 && status < 600) {
        violations.push({
          file,
          line: lineOf(content, match.index),
          snippet: `new NextResponse(JSON.stringify(${innerBody.slice(0, 40).replace(/\s+/g, " ")}), ...) (variable-held body, status ${status}, cannot verify ok:false statically)`,
        });
      }
    }
  }

  return violations;
}

describe("app/api (and middleware.ts) error responses carry ok:false", () => {
  it("every error response body literal also sets ok:false", () => {
    const files = [...walk(API_ROOT), MIDDLEWARE_PATH];
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
