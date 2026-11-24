/**
 * Identity-broker registration endpoint.
 *
 * Contract (shared with agent-tasks, deploy-panel):
 *   POST /api/auth/register-from-project-pilot
 *   Body:     { githubAccessToken: string, githubLogin?: string }
 *   Response: { apiToken, userId, githubLogin }
 *   Errors:   400 missing fields
 *             401 invalid token / login mismatch
 *             403 forbidden_github_login (login not in ALLOWED_GITHUB_LOGINS)
 *             409 account_exists_link_required (a password-less row without a
 *                 githubId holds the email, or a password account without a
 *                 githubId holds the email and any row is already on the
 *                 placeholder `github-<id>@noreply`; a password account alone
 *                 no longer causes it, see "Email collisions" below; also a
 *                 unique violation on the email when another GitHub identity
 *                 holds the address it would be keyed on)
 *             500 internal
 *             503 upstream_unavailable (GitHub unreachable, or GitHub could
 *                 not list the account's emails; nothing is written)
 *
 * Verified email: the email a new row is keyed on, and the one an existing
 * identity row moves to, is an address GitHub lists as verified for the account
 * (`GET /user/emails`, needs the `user:email` scope), never the unverified
 * public profile address from `GET /user`. A new row is keyed on the reported
 * address when it is verified, else on the account's verified primary address,
 * else on the placeholder `github-<id>@noreply`; an existing identity row keeps
 * its email unless the reported address is verified and held by no other row.
 * This is the same rule as the web GitHub sign-in (resolveGithubEmail in
 * lib/github-verified-email.ts).
 *
 * Email collisions: registration does not verify the email, so a password
 * account holding the GitHub user's email may belong to someone who only typed
 * the address. When the email is held by a password account without a
 * githubId, the identity gets its own row under the placeholder
 * `github-<id>@noreply` (the same rule as the web GitHub sign-in, lib/auth.ts);
 * the password account is not touched and receives no token. Later calls match
 * that row by githubId. A row of another GitHub identity is not diverted.
 *
 * project-forge does NOT blindly trust the caller (project-pilot). The
 * access-token is re-verified against `api.github.com/user`. A compromised
 * broker cannot impersonate users because the token has to be valid.
 *
 * The returned apiToken is project-forge's own `pf_*` API token — the broker
 * stores it encrypted and forwards it on subsequent API calls. API tokens
 * are hashed at rest (see lib/db.ts hashApiToken()), so the raw value is
 * never persisted and cannot be recovered on a later call: a second call
 * for the same GitHub identity revokes the existing active token and mints
 * a fresh one (invalidate + re-issue) rather than returning the same value
 * again. This keeps the "at most one active project-pilot token per user"
 * invariant the old reuse branch cared about, at the cost of no longer
 * being idempotent BY VALUE. The broker is documented to cache whatever's
 * returned and only re-register on 401, so this remains a rare path.
 *
 * Point-in-time cross-repo observation (as of 2026-07-14, per project-pilot
 * backend/src/routes/oauth.ts:190): this endpoint's only caller is
 * project-pilot's OAuth-completion handler, which persists the returned
 * token encrypted via upsertCredential and has no automatic 401-triggered
 * re-register loop — so the revoke-and-reissue behavior above cannot
 * spuriously invalidate a token another concurrent "legitimate" flow is
 * mid-use with. Re-check this against project-pilot if that call site
 * changes.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, createApiToken } from "@/lib/db";
import { encryptGithubPat, readGithubPat } from "@/lib/github-pat";
import {
  fetchGitHubUser,
  GitHubAuthError,
  GitHubUnreachableError,
} from "@/lib/github";
import { resolveGithubEmail } from "@/lib/github-verified-email";
import { readJsonBody, BodyTooLargeError } from "@/lib/read-json-body";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

interface RegisterBody {
  githubAccessToken: unknown;
  githubLogin?: unknown;
}

export async function POST(req: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await readJsonBody(req, DEFAULT_MAX_BODY_BYTES)) as RegisterBody;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        {
          ok: false,
          error: "payload_too_large",
          message: `Request body exceeds the ${err.maxBytes.toLocaleString()} byte limit`,
        },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "bad_request", message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body.githubAccessToken !== "string" || body.githubAccessToken.length === 0) {
    return NextResponse.json(
      { ok: false, error: "bad_request", message: "githubAccessToken is required" },
      { status: 400 },
    );
  }
  // Capture the validated token: control-flow narrowing on body.githubAccessToken
  // is lost across the GitHub-verification call below, so hold a typed const.
  const githubAccessToken: string = body.githubAccessToken;
  if (body.githubLogin !== undefined && typeof body.githubLogin !== "string") {
    return NextResponse.json(
      { ok: false, error: "bad_request", message: "githubLogin must be a string if provided" },
      { status: 400 },
    );
  }

  let githubUser;
  try {
    githubUser = await fetchGitHubUser(githubAccessToken);
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return NextResponse.json(
        { ok: false, error: "unauthorized", message: "GitHub access-token verification failed" },
        { status: 401 },
      );
    }
    if (err instanceof GitHubUnreachableError) {
      return NextResponse.json(
        {
          ok: false,
          error: "upstream_unavailable",
          message: "Could not reach GitHub to verify access-token; retry shortly",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "internal", message: "Unexpected error verifying access-token" },
      { status: 500 },
    );
  }

  if (body.githubLogin && body.githubLogin !== githubUser.login) {
    return NextResponse.json(
      {
        ok: false,
        error: "unauthorized",
        message: "Claimed githubLogin does not match verified GitHub identity",
      },
      { status: 401 },
    );
  }

  // Optional stop-gap allowlist, mirrored from deploy-panel (#57) and
  // agent-tasks (#178). Empty/unset env var = back-compat accept-any;
  // set to a comma-separated list to gate broker registration to those
  // GitHub logins. Becomes optional product policy once per-user data
  // isolation is in place.
  const allowedGitHubLogins = (process.env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    allowedGitHubLogins.length > 0 &&
    !allowedGitHubLogins.includes(githubUser.login)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden_github_login",
        message: "This GitHub login is not permitted on this project-forge instance",
      },
      { status: 403 },
    );
  }

  const githubId = String(githubUser.id);
  const placeholderEmail = `github-${githubId}@noreply`;
  // The public profile email from GET /user. GitHub does not say whether it is
  // verified, so it is only a candidate: a row is keyed on it (or looked up by
  // it) only after GitHub lists it as verified for this account, see
  // resolveGithubEmail (the same rule as the web sign-in, lib/auth.ts).
  const reportedEmail = githubUser.email?.toLowerCase() ?? null;

  const linkRequired = () =>
    NextResponse.json(
      {
        ok: false,
        error: "account_exists_link_required",
        message:
          "An account with this email already exists. Sign in with your " +
          "existing credentials first, then link GitHub.",
      },
      { status: 409 },
    );
  // GitHub could not be asked about the email (network error, timeout, no
  // usable answer). Nothing has been written; a retry decides.
  const emailLookupUnavailable = () =>
    NextResponse.json(
      {
        ok: false,
        error: "upstream_unavailable",
        message: "Could not reach GitHub to verify the account email; retry shortly",
      },
      { status: 503 },
    );

  // Lookup by githubId first (stable across GitHub rename).
  const existingByGithubId = await prisma.user.findUnique({ where: { githubId } });

  // Email the new row is keyed on (no identity row yet): an address GitHub
  // lists as verified for the account, else the placeholder.
  let rowEmail: string = placeholderEmail;
  // Email an existing identity row moves to: only an address GitHub lists as
  // verified, and only when no other row holds it.
  let updatedEmail: string | null = existingByGithubId?.email ?? null;

  if (!existingByGithubId) {
    const resolved = await resolveGithubEmail(reportedEmail, githubAccessToken, placeholderEmail);
    if (resolved === null) return emailLookupUnavailable();
    rowEmail = resolved.toLowerCase();

    // Email-collision guard. Registration does not verify emails, so a row
    // holding the address proves nothing about who owns it. Rows that hold the
    // verified address and have no githubId:
    //  - a password account: not merged and not touched (anyone who controls the
    //    email on GitHub could otherwise take the account over, and the typed-in
    //    owner of a password account could read the token). The identity gets
    //    its own row under the placeholder email, the same rule as the web
    //    GitHub sign-in (lib/auth.ts), so the person who owns the address on
    //    GitHub is not locked out by whoever registered it first;
    //  - a password-less row (made by an earlier GitHub-only sign-in): not
    //    claimed here, the web sign-in does that with a verified email. Surface a
    //    structured 409 so project-pilot can prompt the user to sign in on
    //    project-forge directly.
    // A row with a githubId (another identity) is not diverted: the create
    // below fails on the unique email and answers the same 409.
    if (rowEmail !== placeholderEmail) {
      const existingByEmail = await prisma.user.findUnique({ where: { email: rowEmail } });
      if (existingByEmail && !existingByEmail.githubId) {
        if (!existingByEmail.passwordHash) return linkRequired();
        // The placeholder is reserved for GitHub sign-ins (registration refuses
        // it), so a row on it is never a password row. Any row already on it
        // (a legacy GitHub-only row, or one that has a githubId) is refused
        // with the 409 and not claimed here.
        const existingPlaceholder = await prisma.user.findUnique({ where: { email: placeholderEmail } });
        if (existingPlaceholder) return linkRequired();
        rowEmail = placeholderEmail;
      }
    }
  } else if (reportedEmail && reportedEmail !== existingByGithubId.email) {
    // An identity row keeps its email when the reported address is held by
    // another row (typically the password account this identity was kept apart
    // from): the unique index would otherwise fail every later call. It also
    // keeps it unless GitHub lists the address as verified.
    const holder = await prisma.user.findUnique({ where: { email: reportedEmail } });
    if (!holder) {
      const resolved = await resolveGithubEmail(reportedEmail, githubAccessToken, placeholderEmail);
      if (resolved === null) return emailLookupUnavailable();
      if (resolved.toLowerCase() === reportedEmail) updatedEmail = reportedEmail;
    }
  }

  // Decide whether to (re)store the verified OAuth token as githubPat. Refresh
  // it when there is none yet OR when the existing value is itself an OAuth
  // token (gho_): that way scope upgrades on the project-pilot side (e.g.
  // adding `workflow`) propagate on the next login instead of leaving the old,
  // narrower-scoped token stuck. A manually-entered PAT (classic ghp_ or
  // fine-grained github_pat_) is preserved, never overwritten. A stored value
  // that no longer decrypts (key rotated) counts as none and is replaced.
  const updateIdentity = async (row: NonNullable<typeof existingByGithubId>, email: string | null) => {
    const existingPat = await readGithubPat(row);
    const preserveManualPat = !!existingPat && !existingPat.startsWith("gho_");
    return prisma.user.update({
      where: { id: row.id },
      data: {
        githubLogin: githubUser.login,
        email,
        // githubOwner/passwordHash stay untouched.
        ...(preserveManualPat ? {} : { githubPat: encryptGithubPat(githubAccessToken) }),
      },
    });
  };

  // A unique violation (P2002) is one of two races, both settled here:
  //  - on create: the identity row appeared in between (the web sign-in made it
  //    on the githubId or the placeholder). Re-read it by githubId once and
  //    continue as an update that leaves its email alone. Prisma names the
  //    violated field in meta.target (an array of field names on SQLite, and
  //    only the first one when several are violated), so the re-read, not the
  //    target, tells the races apart;
  //  - no such row: the email is held by another identity (or a placeholder
  //    race lost to a row that is not this identity's): the error is rethrown
  //    and the outer catch answers the structured 409, as it does for a unique
  //    violation of the later update.
  // Any other error propagates as before.
  let user;
  try {
    if (existingByGithubId) {
      user = await updateIdentity(existingByGithubId, updatedEmail);
    } else {
      try {
        user = await prisma.user.create({
          data: {
            githubId,
            githubLogin: githubUser.login,
            email: rowEmail,
            // Store the verified OAuth access-token as the GitHub PAT so a
            // project-pilot SSO user can publish immediately, without connecting
            // GitHub a second time on the forge side. pilot's OAuth requests the
            // `repo` scope, which is what createAndPushRepo needs.
            githubPat: encryptGithubPat(githubAccessToken),
            // OAuth-provisioned users have no password; column is nullable.
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const raced = await prisma.user.findUnique({ where: { githubId } });
        if (!raced) throw err;
        user = await updateIdentity(raced, raced.email ?? null);
      }
    }
  } catch (err) {
    if (isUniqueViolation(err)) return linkRequired();
    throw err;
  }

  // At most one active "project-pilot" token per user, even under
  // concurrent calls. Revoke via updateMany (a single atomic
  // UPDATE ... WHERE revokedAt IS NULL) rather than findFirst-then-update-
  // by-id, and run both statements in one transaction: two racing calls
  // can't each read the same now-stale "active" row and then both revoke +
  // create, which would leave two tokens active at once. The second call's
  // updateMany also sweeps up the first call's freshly created row. Hash-
  // at-rest means an existing token's raw value can no longer be recovered,
  // so a repeat call issues a fresh one instead of returning the same value
  // again (see file-level comment above).
  //
  // CAVEAT: the "no two active tokens" invariant above relies on this
  // project's datasource being SQLite, which serializes writers (one
  // writer transaction at a time) — there is no genuine cross-transaction
  // race to close here. Porting this to a true MVCC datastore (Postgres,
  // etc.) would need an explicit guard (a partial unique index on
  // (userId, name) WHERE revokedAt IS NULL, or a row lock) for the same
  // guarantee to hold under real concurrent writers.
  const { raw: apiToken } = await prisma.$transaction(async (tx) => {
    await tx.apiToken.updateMany({
      where: { userId: user.id, name: "project-pilot", revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return createApiToken(tx, user.id, "project-pilot");
  });

  return NextResponse.json({
    apiToken,
    userId: user.id,
    githubLogin: githubUser.login,
  });
}
