import { clientAddressFromHeaders } from "./signin-rate-limit";

/**
 * Attempt limiter for `POST /api/auth/register` (app/api/auth/register/route.ts).
 *
 * Unlike the sign-in limiter this counts EVERY attempt that passes the cheap
 * body and format checks, successful registrations included: creating user
 * accounts is the abuse here, so a success must not hand its attempt back.
 * The attempt is taken before the database lookup and before bcrypt, so a
 * caller over the limit costs one map lookup and nothing else.
 *
 * The counter is per client address (the last `X-Forwarded-For` entry, see
 * clientAddressFromHeaders in lib/signin-rate-limit.ts: one trusted proxy
 * hop, a spoofed left-hand entry cannot pick the counted address). A request
 * with no usable address (no proxy in front, or a header whose last entry is
 * not an IP) is counted on ONE shared fallback key with the same cap, so a
 * proxy-less deployment is still bounded.
 *
 * Storage and bounds follow lib/signin-rate-limit.ts: process memory (per
 * process, reset on restart), a fixed window that starts at the first attempt
 * of a key, at most MAX_TRACKED_REGISTER_KEYS entries. When the map is full,
 * expired entries are pruned first, then the entry with the lowest count
 * below the limit (the oldest on a tie) is evicted; an entry at its limit is
 * never evicted, and if every entry is at its limit a new key is allowed but
 * untracked until a window ends.
 */

/** Attempts allowed per client address (or on the fallback key) within the window. */
export const REGISTER_MAX_ATTEMPTS = 5;
/** Length of the counting window, started by the first attempt of a key. */
export const REGISTER_WINDOW_MS = 60 * 60 * 1000;
/** Hard cap on tracked keys in the map. */
export const MAX_TRACKED_REGISTER_KEYS = 10_000;

/** Shared key for requests with no usable client address; never a real address. */
export const NO_ADDRESS_KEY = "__no_client_address__";

type Entry = { count: number; windowEnd: number };

const registerAttempts = new Map<string, Entry>();

function live(key: string, now: number): Entry | undefined {
  const entry = registerAttempts.get(key);
  if (!entry) return undefined;
  if (entry.windowEnd <= now) {
    registerAttempts.delete(key);
    return undefined;
  }
  return entry;
}

function prune(now: number): void {
  for (const [key, entry] of registerAttempts) {
    if (entry.windowEnd <= now) registerAttempts.delete(key);
  }
}

/** Makes room in a full map; false when every entry is at its limit. */
function makeRoom(now: number): boolean {
  if (registerAttempts.size < MAX_TRACKED_REGISTER_KEYS) return true;
  prune(now);
  if (registerAttempts.size < MAX_TRACKED_REGISTER_KEYS) return true;
  // Lowest count below the limit; the first one found is the oldest (Map
  // keeps insertion order), so a tie goes to the oldest entry.
  let victim: string | undefined;
  let lowest = REGISTER_MAX_ATTEMPTS;
  for (const [key, entry] of registerAttempts) {
    if (entry.count < lowest) {
      lowest = entry.count;
      victim = key;
    }
  }
  if (victim === undefined) return false;
  registerAttempts.delete(victim);
  return true;
}

/**
 * Takes one registration attempt for this address, or refuses it.
 *
 * Returns false (nothing counted) when the address (or the shared fallback
 * key) has already used up its attempts in the window; the caller then answers
 * 429 without a database read or a bcrypt run. Otherwise the attempt is
 * counted at once, before any asynchronous work, so a burst of parallel
 * requests cannot all pass the check first. Counted attempts are never handed
 * back, not even on a successful registration.
 */
export function takeRegisterAttempt(address: string | null, now: number = Date.now()): boolean {
  const key = address ?? NO_ADDRESS_KEY;
  const entry = live(key, now);
  if (entry) {
    if (entry.count >= REGISTER_MAX_ATTEMPTS) return false;
    entry.count += 1;
    return true;
  }
  if (!makeRoom(now)) return true; // untracked: allowed, not counted
  registerAttempts.set(key, { count: 1, windowEnd: now + REGISTER_WINDOW_MS });
  return true;
}

/** Test hook: size of the map. */
export function trackedRegisterKeyCount(): number {
  return registerAttempts.size;
}

/** Test hook: forget every counter. */
export function resetRegisterLimiter(): void {
  registerAttempts.clear();
}

export { clientAddressFromHeaders };
