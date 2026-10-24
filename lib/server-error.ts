import { randomUUID } from "crypto";

/**
 * Log an unexpected server-side failure and return the text for the `details`
 * field of a 500 response. The raw exception message (which can carry Prisma
 * query text, file paths or upstream payloads) stays in the server log; the
 * client only gets a generic sentence plus a short reference id that ties the
 * response to the log line.
 *
 * Lives in lib/ rather than a route module because Next.js route files may
 * only export HTTP handlers and a fixed set of config fields.
 */
export function internalErrorDetails(scope: string, error: unknown): string {
  const ref = randomUUID().slice(0, 8);
  console.error(`[${ref}] ${scope}:`, error);
  return `An internal error occurred. Reference: ${ref}`;
}
