import { createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * Failure limiter for the credentials sign-in (`authorize` in lib/auth.ts).
 *
 * Failed attempts are counted per normalized email and per client address in a
 * fixed window that starts at the first attempt of a key. Once a key has
 * reached its limit, every further attempt on it is refused until the window
 * has passed, without a database read or a bcrypt run. An attempt is counted
 * when it starts and handed back when it succeeds (see consumeSignInAttempt),
 * so what stays counted are failures.
 *
 * Storage is process memory: the app is one Next.js instance on SQLite. The
 * counters are per process and reset on restart or redeploy; a second instance
 * would have its own counters. Memory is bounded: expired entries are pruned
 * whenever a map is full, and a map never holds more than MAX_TRACKED_KEYS
 * entries. When a full map has no expired entry, the entry with the lowest
 * count (the oldest on a tie) among those still below their limit is evicted
 * for the new key; an entry at its limit is never evicted, so a flood of junk
 * keys cannot unlock a locked one. If every entry is at its limit, the new key
 * is simply not tracked (its attempt is allowed but uncounted) until a window
 * ends.
 */

/** Failed attempts allowed per email within the window. */
export const EMAIL_MAX_FAILURES = 10;
/** Failed attempts allowed per client address within the window. */
export const ADDRESS_MAX_FAILURES = 30;
/** Length of the counting window, started by the first failure of a key. */
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
/** Hard cap on tracked keys per map (email and address maps are separate). */
export const MAX_TRACKED_KEYS = 10_000;
type Entry = { count: number; windowEnd: number };

const emailFailures = new Map<string, Entry>();
const addressFailures = new Map<string, Entry>();

/**
 * Limiter key for an email: a digest of the EXACT submitted string, the value
 * the database lookup matches. No trimming and no case folding: the user table
 * matches the email byte for byte, so "Victim@x.com" and "victim@x.com" are
 * different accounts, and a shared counter would let a success on one account
 * clear the failures counted against the other. The digest only bounds the
 * key size; two different strings never share a key.
 */
export function emailLimiterKey(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

/**
 * Client address from the `X-Forwarded-For` header of the request.
 *
 * Production runs behind one reverse proxy (Traefik), which appends the
 * address of its TCP peer as the LAST entry of X-Forwarded-For. Entries to the
 * left of it are whatever the client sent and are never used: taking the
 * right-most entry (one trusted hop) means a spoofed header cannot choose the
 * address that is counted. Returns null when the header is missing or its last
 * entry is not an IP address (no proxy in front, for example in development);
 * the caller then limits per email only.
 */
export function clientAddressFromHeaders(headers: unknown): string | null {
  const raw = (headers as Record<string, unknown> | null | undefined)?.["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (typeof value !== "string") return null;
  const last = value.split(",").pop()?.trim() ?? "";
  return isIP(last) ? last.toLowerCase() : null;
}

function live(map: Map<string, Entry>, key: string, now: number): Entry | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.windowEnd <= now) {
    map.delete(key);
    return undefined;
  }
  return entry;
}

function prune(map: Map<string, Entry>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.windowEnd <= now) map.delete(key);
  }
}

/** Makes room in a full map; false when every entry is at its limit. */
function makeRoom(map: Map<string, Entry>, now: number, limit: number): boolean {
  if (map.size < MAX_TRACKED_KEYS) return true;
  prune(map, now);
  if (map.size < MAX_TRACKED_KEYS) return true;
  // Lowest count below the limit; the first one found is the oldest (Map
  // keeps insertion order), so a tie goes to the oldest entry.
  let victim: string | undefined;
  let lowest = limit;
  for (const [key, entry] of map) {
    if (entry.count < lowest) {
      lowest = entry.count;
      victim = key;
    }
  }
  if (victim === undefined) return false;
  map.delete(victim);
  return true;
}

function bump(map: Map<string, Entry>, key: string, now: number, limit: number): void {
  const entry = live(map, key, now);
  if (entry) {
    entry.count += 1;
    return;
  }
  if (!makeRoom(map, now, limit)) return;
  map.set(key, { count: 1, windowEnd: now + SIGNIN_WINDOW_MS });
}

/**
 * Takes one sign-in attempt for this email and address, or refuses it.
 *
 * Returns false (nothing counted) when the email or the address has already
 * used up its attempts in the window. Otherwise the attempt is counted at
 * once, before the caller does any asynchronous work: counting only after a
 * failed bcrypt run would let a burst of parallel requests all pass the check
 * first. A successful sign-in hands the attempt back with
 * `releaseSignInAttempt`, so only failed (and still running) attempts stay
 * counted.
 */
export function consumeSignInAttempt(
  emailKey: string,
  address: string | null,
  now: number = Date.now(),
): boolean {
  if ((live(emailFailures, emailKey, now)?.count ?? 0) >= EMAIL_MAX_FAILURES) return false;
  if (address !== null && (live(addressFailures, address, now)?.count ?? 0) >= ADDRESS_MAX_FAILURES) {
    return false;
  }
  bump(emailFailures, emailKey, now, EMAIL_MAX_FAILURES);
  if (address !== null) bump(addressFailures, address, now, ADDRESS_MAX_FAILURES);
  return true;
}

/**
 * A successful sign-in clears the email counter and gives back its own attempt
 * on the address counter. The address counter is otherwise kept: an attacker
 * who owns one valid account cannot reset the address budget between guesses
 * against other accounts.
 */
export function releaseSignInAttempt(
  emailKey: string,
  address: string | null,
  now: number = Date.now(),
): void {
  emailFailures.delete(emailKey);
  if (address === null) return;
  const entry = live(addressFailures, address, now);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) addressFailures.delete(address);
}

/** Test hook: sizes of the two maps. */
export function trackedKeyCounts(): { emails: number; addresses: number } {
  return { emails: emailFailures.size, addresses: addressFailures.size };
}

/** Test hook: forget every counter. */
export function resetSignInLimiter(): void {
  emailFailures.clear();
  addressFailures.clear();
}
