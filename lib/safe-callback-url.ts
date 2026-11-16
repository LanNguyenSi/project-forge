// Where the login page sends a visitor after a successful sign-in. The value
// comes from the `callbackUrl` query parameter, which anyone can craft, so it
// is only used when it is a same-origin relative path; everything else falls
// back to the dashboard (an open redirect would turn the login page into a
// phishing launchpad).

export const DEFAULT_CALLBACK_URL = "/dashboard";

const RESOLVE_BASE = "http://callback.invalid";

// C0 controls (tab, CR and LF are stripped by URL parsers, which would turn
// "/\t/evil.test" into "//evil.test") and DEL.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSafeRelativePath(value: string): boolean {
  if (value[0] !== "/") return false;
  // "//host" is protocol-relative; browsers read "/\host" the same way.
  if (value[1] === "/" || value[1] === "\\") return false;
  if (CONTROL_CHARS.test(value)) return false;
  // Resolve it the way a browser does: dot segments and backslashes can turn
  // "/.//evil.test" or "/a\\..\\\\evil.test" into "//evil.test" after the
  // checks above. Against a base URL a value with a single leading "/" cannot
  // leave the base's origin, so only the resulting path needs a look.
  return !new URL(value, RESOLVE_BASE).pathname.startsWith("//");
}

/**
 * Returns `raw` when it is a safe same-origin relative path (a single leading
 * `/`, no `//` or `/\` prefix, no control characters, also after one round of
 * percent-decoding), otherwise "/dashboard". Absent, empty, non-string and
 * undecodable values fall back too. The value is returned as given, never
 * trimmed: a leading space is a rejection, not something to repair.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_CALLBACK_URL;
  if (!isSafeRelativePath(raw)) return DEFAULT_CALLBACK_URL;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
  if (!isSafeRelativePath(decoded)) return DEFAULT_CALLBACK_URL;
  return raw;
}
