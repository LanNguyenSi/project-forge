import { PrismaClient } from "@prisma/client";

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

export async function validateApiToken(token: string) {
  if (!token.startsWith("pf_")) return null;
  const record = await prisma.apiToken.findUnique({
    where: { token },
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
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "pf_";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
