import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Attachment } from "@/lib/types";

/**
 * Where inside the scaffolded repo uploaded attachments land. Nested
 * subdir (`docs/context/`, not `docs/`) so scaffold templates that
 * already ship a `docs/` can coexist without name-collision on top-level
 * files like `docs/README.md`. Writing a README.md inside the subdir
 * targets only our own turf.
 */
export const SCAFFOLD_ATTACHMENTS_DIR = "docs/context";

/**
 * Reject a user-supplied filename that would escape
 * `${tempDir}/${SCAFFOLD_ATTACHMENTS_DIR}` — `../` segments, absolute
 * paths, nested slashes, backslashes, NULs. Keeps the serverside write
 * inside the scaffold directory regardless of what the API caller sent.
 * Matches the containment discipline used in agent-relay's
 * assertComposeFileContained.
 */
function isSafeFilename(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  // Reject any separator or traversal token outright — we're writing
  // one flat file into the attachments dir, not recreating a tree.
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

/**
 * Pre-filter attachments down to the ones we can safely persist.
 * Text-tier only (diagram/structured inlineText is either absent or
 * contains the raw binary the UI couldn't display anyway), non-empty
 * inlineText, safe filename. Attachments that fail the filter are
 * silently skipped — the caller logs the count so operators can notice.
 */
export function persistableAttachments(attachments: Attachment[] | undefined): Attachment[] {
  if (!attachments || attachments.length === 0) return [];
  const out: Attachment[] = [];
  for (const a of attachments) {
    if (a.tier !== "text") continue;
    if (typeof a.inlineText !== "string" || a.inlineText.length === 0) continue;
    if (!isSafeFilename(a.name)) continue;
    out.push(a);
  }
  return out;
}

/**
 * Format a single line for the README index.
 */
function readmeLine(a: Attachment): string {
  const charCount = (a.inlineText?.length ?? 0).toLocaleString("en-US");
  return `- [${a.name}](./${a.name}) — ${charCount} chars, ${a.mimeType}`;
}

/**
 * Write attachments into `${scaffoldRoot}/docs/context/<name>` and
 * produce a README.md index. Idempotent on re-run (overwrites the
 * same filenames and the README).
 *
 * **Not a full sync.** If run N+1 has fewer attachments than run N,
 * stale files from run N are NOT removed. That's safe for the current
 * route (each request gets a fresh UUID tempdir — no re-entry into the
 * same directory) but worth knowing before wiring this into any other
 * flow.
 *
 * No-op when nothing is persistable — docs/context/ is not created,
 * so scaffold trees stay pristine for the no-attachment flow.
 *
 * @returns the list of attachments actually written, so the caller can
 *          log the count and surface it in generation metadata.
 */
export async function writeAttachmentsToScaffold(
  scaffoldRoot: string,
  attachments: Attachment[] | undefined,
): Promise<Attachment[]> {
  const toWrite = persistableAttachments(attachments);
  if (toWrite.length === 0) return [];

  const dir = path.join(scaffoldRoot, SCAFFOLD_ATTACHMENTS_DIR);
  await fs.mkdir(dir, { recursive: true });

  // Runtime containment guard: even though `isSafeFilename` rejects
  // traversal tokens at the filter layer, belt-and-braces here catches
  // any future filter regression at the write layer. If a crafted name
  // ever slipped through the filter, `path.resolve(dir, name)` would
  // land above `dir` and this check throws before the write happens.
  const dirAbs = path.resolve(dir);
  const dirPrefix = dirAbs + path.sep;

  // Use 0o644 (world-readable): these files end up in a published repo
  // and have no secret value beyond what the user chose to upload.
  // Explicit mode documents the intent (Node's default depends on umask).
  for (const a of toWrite) {
    const target = path.resolve(dir, a.name);
    if (!target.startsWith(dirPrefix)) {
      throw new Error(
        `attachment filename escapes scaffold dir: ${JSON.stringify(a.name)}`,
      );
    }
    await fs.writeFile(target, a.inlineText ?? "", {
      encoding: "utf8",
      mode: 0o644,
    });
  }

  const readme = [
    "# Planning Context",
    "",
    "This directory contains the original documents uploaded when this",
    "project was created. They were fed into the planning prompt as",
    "additional context (see `project-forge` attachments v0.1b / v0.1d).",
    "",
    "## Attachments",
    "",
    ...toWrite.map(readmeLine),
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "README.md"), readme, {
    encoding: "utf8",
    mode: 0o644,
  });

  return toWrite;
}
