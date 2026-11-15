import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes, randomUUID } from "crypto";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["error"] : [] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Rate limit: max 10 projects per user in any rolling 24-hour window
export const RATE_LIMIT_PER_DAY = 10;

// A reservation (UsageLog row with repoUrl NULL) is written when a publish
// request starts and filled in when the repo was pushed. The slowest request
// (generate + push) takes a few minutes, so a reservation counts against the
// quota for this long. A reservation older than that belongs to a request
// that died without releasing it (process crash, restart) and stops counting,
// so a crash cannot burn quota for the whole 24 hours.
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Narrow client shape so a test can hand in its own PrismaClient (separate
// connections to one SQLite file) instead of the module singleton.
type UsageClient = Pick<PrismaClient, "$executeRaw" | "usageLog">;

export type UsageReservation =
  | { allowed: true; reservationId: string }
  | { allowed: false; used: number };

/**
 * Checks the quota and reserves one slot in a single step.
 *
 * The count and the insert are ONE statement (`INSERT ... SELECT ... WHERE
 * (SELECT count(*) ...) < limit`). SQLite takes the write lock when such a
 * statement starts, so the count is read under that lock and two parallel
 * requests can never both see "9 used" and both insert. A count-then-create
 * pair of statements would not give that: the slot would be taken only after
 * the slow git push, and N parallel requests would all read the same count.
 *
 * Counted rows: every row of the last 24 hours that has a repoUrl (a finished
 * publish, soft-deleted ones included, as before), plus reservations younger
 * than RESERVATION_TTL_MS. The reservation is released with releaseUsage()
 * when the request fails, so a failed attempt does not burn quota, and is
 * completed with confirmUsage() when it succeeds.
 *
 * Relies on the datasource being SQLite (a single writer at a time); on an
 * MVCC database the statement alone would not serialize concurrent callers.
 */
export async function reserveUsage(
  userId: string,
  tokenId: string,
  client: UsageClient = prisma
): Promise<UsageReservation> {
  const now = Date.now();
  const id = randomUUID();
  const inserted = await client.$executeRaw`
    INSERT INTO "UsageLog" ("id", "userId", "tokenId", "createdAt")
    SELECT ${id}, ${userId}, ${tokenId}, ${new Date(now)}
    WHERE (
      SELECT count(*) FROM "UsageLog"
      WHERE "userId" = ${userId}
        AND "createdAt" >= ${new Date(now - DAY_MS)}
        AND ("repoUrl" IS NOT NULL OR "createdAt" >= ${new Date(now - RESERVATION_TTL_MS)})
    ) < ${RATE_LIMIT_PER_DAY}`;
  if (inserted === 1) return { allowed: true, reservationId: id };

  // Refused. The number is only shown to the caller (429 details), the
  // decision above is already made.
  const used = await client.usageLog.count({
    where: {
      userId,
      createdAt: { gte: new Date(now - DAY_MS) },
      OR: [{ repoUrl: { not: null } }, { createdAt: { gte: new Date(now - RESERVATION_TTL_MS) } }],
    },
  });
  return { allowed: false, used };
}

/** Turns a reservation into the normal usage row of the published repo. */
export async function confirmUsage(
  reservationId: string,
  repoUrl: string,
  client: Pick<PrismaClient, "usageLog"> = prisma
): Promise<void> {
  await client.usageLog.update({ where: { id: reservationId }, data: { repoUrl } });
}

/**
 * Gives a reservation back after a failed request. Never throws: it runs on
 * error paths, where a second failure must not replace the response; a
 * release that fails leaves the reservation to expire after RESERVATION_TTL_MS.
 */
export async function releaseUsage(
  reservationId: string,
  client: Pick<PrismaClient, "usageLog"> = prisma
): Promise<void> {
  try {
    await client.usageLog.deleteMany({ where: { id: reservationId, repoUrl: null } });
  } catch (error) {
    console.error("releaseUsage failed; the reservation expires on its own", error);
  }
}

// API tokens are hashed at rest (keyed SHA-256 / HMAC-SHA256) rather than
// stored in plaintext. A keyed hash keeps token lookup a plain unique-index
// equality check (`WHERE tokenHash = ?`), which a per-row bcrypt/argon2
// compare cannot offer without iterating every active token.
//
// The HMAC key defaults to NEXTAUTH_SECRET, which is already a required app
// secret, so existing deployments need no new config. Set
// API_TOKEN_HASH_SECRET to use a dedicated key that can rotate independently
// of the session secret (rotating either one invalidates every issued API
// token, since the hash can no longer be reproduced — same blast radius as
// NextAuth session-secret rotation already has today).
function getTokenHashSecret(): string {
  const secret = process.env.API_TOKEN_HASH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "API_TOKEN_HASH_SECRET (or NEXTAUTH_SECRET) must be set to hash/verify API tokens"
    );
  }
  return secret;
}

export function hashApiToken(rawToken: string): string {
  return createHmac("sha256", getTokenHashSecret()).update(rawToken).digest("hex");
}

// Non-secret display hint for the dashboard's masked token list, e.g.
// "pf_ab12cd3" (10 chars: the "pf_" prefix + 7 of the 32 base64url chars
// generateApiToken() produces from its 24 random bytes). Long enough to
// tell tokens apart, short enough to leave the ~25 remaining base64url
// characters of the secret (~150 bits) unguessable.
export function tokenPrefixOf(rawToken: string): string {
  return rawToken.slice(0, 10);
}

export async function validateApiToken(token: string) {
  if (!token.startsWith("pf_")) return null;
  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    include: { user: true },
  });
  if (!record || record.revokedAt) return null;
  // Update lastUsedAt
  await prisma.apiToken.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });
  return record;
}

export function generateApiToken(): string {
  return `pf_${randomBytes(24).toString("base64url")}`;
}

/**
 * Creates a new API token row and returns the one and only time the raw
 * secret is available: the caller must hand `raw` back to the end user
 * immediately (dashboard "show once" UI, or the register-from-project-pilot
 * broker response) and never persist it — it cannot be recovered from the
 * DB afterwards, only re-verified via hashApiToken().
 *
 * Takes the Prisma client explicitly (rather than closing over the module's
 * own `prisma` export) so callers that test against a swapped-in mock
 * client get that mock here too, instead of this function silently talking
 * to the real database underneath the mock. Only requires an `apiToken.create`
 * method (not the full PrismaClient shape) so a minimal test double works.
 */
export async function createApiToken(
  client: { apiToken: Pick<PrismaClient["apiToken"], "create"> },
  userId: string,
  name: string
) {
  const raw = generateApiToken();
  const record = await client.apiToken.create({
    data: {
      tokenHash: hashApiToken(raw),
      tokenPrefix: tokenPrefixOf(raw),
      name,
      userId,
    },
  });
  return { raw, record };
}
