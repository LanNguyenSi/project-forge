import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "crypto";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["error"] : [] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Rate limit: max 10 projects per user per day
export const RATE_LIMIT_PER_DAY = 10;

export async function checkRateLimit(userId: string): Promise<{ allowed: boolean; used: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await prisma.usageLog.count({
    where: { userId, createdAt: { gte: since } },
  });
  return { allowed: used < RATE_LIMIT_PER_DAY, used };
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
// "pf_ab12cd34". Long enough to tell tokens apart, short enough to leave the
// ~26 remaining random bytes of the secret unguessable.
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
