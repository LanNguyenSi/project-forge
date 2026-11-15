/**
 * Single source of truth for request-size limits, shared by the API
 * routes and the form UI (components/ProjectForm.tsx imports the
 * attachment constants). The server enforces exactly the numbers the
 * UI already enforces, so a direct API caller gets the same ceilings
 * as the browser rather than different ones.
 */

/**
 * Per-file attachment cap in characters. Matches planforge's
 * 50_000-char total-inlineText cap (v0.1b) and the client-side check
 * in components/ProjectForm.tsx.
 */
export const MAX_ATTACHMENT_CHARS = 50_000;

/**
 * Total attachment characters across one request. The v0.1c UI lets
 * the user attach exactly one file, so per-file === total here; the
 * total check still guards the wire shape independently of the count
 * check so neither limit silently leans on the other.
 */
export const MAX_ATTACHMENT_TOTAL_CHARS = 50_000;

/**
 * Attachment count per request. The v0.1c UI supports a single file
 * (one file input, one attachment in state), so the server pins the
 * same count.
 */
export const MAX_ATTACHMENTS = 1;

/**
 * Attachment filename cap. Mirrors the 200-char rejection in
 * lib/scaffold-attachments.ts isSafeFilename; used here only to size
 * the derived request-body byte caps.
 */
export const ATTACHMENT_NAME_MAX_CHARS = 200;

/**
 * Server-side cap on ai-assist file-mode content, in characters.
 * Mirrors the UI's 50k char limit so a direct API caller (bypassing
 * the browser) can't drive unbounded token costs at our provider.
 * Matches the same cap planforge's v0.1b ingest enforces further down
 * the pipeline.
 */
export const FILE_MODE_MAX_CHARS = 50_000;

/**
 * Server-side cap on ai-assist prompt-mode content, in characters.
 * Mirrors the file-mode cap's intent (bounded token cost) for the
 * free-text seed: the UI's magic-fill textarea ships far shorter
 * prompts, so 10k covers realistic prose while capping what a direct
 * caller can push to the paid provider.
 */
export const PROMPT_MODE_MAX_CHARS = 10_000;

/**
 * ai-assist fileName is sanitized (newlines stripped) and truncated to
 * 200 chars before it enters the user prompt; used here only to size
 * the derived request-body byte cap.
 */
export const AI_ASSIST_FILE_NAME_MAX_CHARS = 200;

/**
 * Byte cap for the small JSON bodies (auth, dashboard, publish, v1
 * one-shot create). These payloads are a few hundred bytes at most;
 * 64 KiB leaves generous headroom while bounding what an anonymous
 * caller can make the server buffer.
 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Worst case JSON encoding of one JS character is "\uXXXX" = 6 bytes.
 * Used to convert the character caps above into byte caps that can
 * never reject a legitimate payload.
 */
export const JSON_MAX_BYTES_PER_CHAR = 6;

/**
 * Flat reserve for JSON scaffolding (keys, quotes, braces, mode field)
 * on top of the per-field worst-case character budgets.
 */
export const JSON_BODY_OVERHEAD_BYTES = 512;

/**
 * Byte cap for POST /api/ai-assist: every field at its char cap, at
 * the worst-case escape width, plus the flat overhead reserve.
 * (FILE_MODE_MAX_CHARS 50_000 + PROMPT_MODE_MAX_CHARS 10_000 +
 * AI_ASSIST_FILE_NAME_MAX_CHARS 200) * 6 + 512 = 361_712 bytes.
 */
export const AI_ASSIST_MAX_BODY_BYTES =
  (FILE_MODE_MAX_CHARS + PROMPT_MODE_MAX_CHARS + AI_ASSIST_FILE_NAME_MAX_CHARS) *
    JSON_MAX_BYTES_PER_CHAR +
  JSON_BODY_OVERHEAD_BYTES;

/**
 * Character budget for the non-attachment text fields of a generate
 * request (projectName, summary, features, constraints, targetUsers).
 * 50k chars is the hosted-provider maxContextChars in
 * lib/ai-provider.ts, the ceiling beyond which the planner pipeline
 * truncates anyway.
 */
export const GENERATE_TEXT_BUDGET_CHARS = 50_000;

/**
 * Byte cap for POST /api/generate and POST /api/v1/generate:
 * attachments at their total + filename caps, the text fields at their
 * character budget, all at the worst-case escape width, plus the flat
 * overhead reserve.
 * (MAX_ATTACHMENT_TOTAL_CHARS 50_000 + MAX_ATTACHMENTS 1 *
 * ATTACHMENT_NAME_MAX_CHARS 200 + GENERATE_TEXT_BUDGET_CHARS 50_000)
 * * 6 + 512 = 601_712 bytes.
 */
export const GENERATE_MAX_BODY_BYTES =
  (MAX_ATTACHMENT_TOTAL_CHARS +
    MAX_ATTACHMENTS * ATTACHMENT_NAME_MAX_CHARS +
    GENERATE_TEXT_BUDGET_CHARS) *
    JSON_MAX_BYTES_PER_CHAR +
  JSON_BODY_OVERHEAD_BYTES;

/**
 * Validate the `attachments` field against the per-file, total and
 * count character caps. Returns a human-readable reason (surfaced in
 * the routes' 413 `details`) or null when the payload is within the
 * limits. Non-array values return null: routes keep their current
 * behavior for those (they never persist them).
 *
 * Check order is per-file, then total, then count, so each limit is
 * the binding one for some payload (and thus independently pinned by
 * a test): one oversized file trips per-file, two mid-size files that
 * together exceed the total trip total, and extra in-budget files trip
 * count.
 */
export function attachmentLimitError(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;

  let totalChars = 0;
  for (const a of attachments) {
    const inlineText =
      a && typeof a === "object" && typeof (a as { inlineText?: unknown }).inlineText === "string"
        ? (a as { inlineText: string }).inlineText
        : "";
    if (inlineText.length > MAX_ATTACHMENT_CHARS) {
      const name =
        a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string"
          ? (a as { name: string }).name
          : "attachment";
      return `attachment "${name}" is ${inlineText.length.toLocaleString("en-US")} chars; limit per file is ${MAX_ATTACHMENT_CHARS.toLocaleString("en-US")}`;
    }
    totalChars += inlineText.length;
    if (totalChars > MAX_ATTACHMENT_TOTAL_CHARS) {
      return `attachments total ${totalChars.toLocaleString("en-US")} chars; limit is ${MAX_ATTACHMENT_TOTAL_CHARS.toLocaleString("en-US")}`;
    }
  }

  if (attachments.length > MAX_ATTACHMENTS) {
    return `too many attachments: ${attachments.length}; limit is ${MAX_ATTACHMENTS}`;
  }

  return null;
}
