import { randomUUID } from "crypto";
import { scrubSecrets } from "@/lib/scrub-secrets";

/**
 * An error whose message is safe and useful to show to the caller (for
 * example "Invalid or expired GitHub PAT"). `internalErrorDetails` passes
 * its message through, scrubbed, instead of replacing it with the generic
 * sentence. Throw it only with fixed or provider-supplied text that cannot
 * carry credentials.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * Log an unexpected server-side failure and return the text for the `details`
 * field of a 500 response. The raw exception message (which can carry Prisma
 * query text, file paths or upstream payloads) stays in the server log, in
 * scrubbed form because Prisma errors can embed argument values such as a
 * GitHub PAT; the client only gets a generic sentence plus a short reference
 * id that ties the response to the log line. A `UserFacingError` is the one
 * exception: its scrubbed message is returned as is.
 *
 * Lives in lib/ rather than a route module because Next.js route files may
 * only export HTTP handlers and a fixed set of config fields.
 */
export function internalErrorDetails(scope: string, error: unknown): string {
  const ref = randomUUID().slice(0, 8);
  const raw =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  console.error(`[${ref}] ${scope}:`, scrubSecrets(raw));
  if (error instanceof UserFacingError) return scrubSecrets(error.message);
  return `An internal error occurred. Reference: ${ref}`;
}
