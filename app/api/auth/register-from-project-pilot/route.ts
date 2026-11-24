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
 *                 no longer causes it, see "Email collisions" below)
 *             500 internal
 *             503 GitHub unreachable
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
import { readJsonBody, BodyTooLargeError } from "@/lib/read-json-body";
import { DEFAULT_MAX_BODY_BYTES } from "@/lib/limits";

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
  const githubEmail = githubUser.email?.toLowerCase() ?? null;

  // Lookup by githubId first (stable across GitHub rename).
  const existingByGithubId = await prisma.user.findUnique({ where: { githubId } });

  // Email-collision guard. The email comes from GET /user and registration
  // does not verify emails, so a row holding it proves nothing about who owns
  // it. Rows that hold the email and have no githubId:
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
  // A row with a githubId (another identity) is left as before.
  const placeholderEmail = `github-${githubId}@noreply`;
  let rowEmail: string | null = githubEmail;
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
  if (!existingByGithubId && githubEmail) {
    const existingByEmail = await prisma.user.findUnique({ where: { email: githubEmail } });
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

  // Decide whether to (re)store the verified OAuth token as githubPat. Refresh
  // it when there is none yet OR when the existing value is itself an OAuth
  // token (gho_): that way scope upgrades on the project-pilot side (e.g.
  // adding `workflow`) propagate on the next login instead of leaving the old,
  // narrower-scoped token stuck. A manually-entered PAT (classic ghp_ or
  // fine-grained github_pat_) is preserved, never overwritten. A stored value
  // that no longer decrypts (key rotated) counts as none and is replaced.
  const existingPat = existingByGithubId ? await readGithubPat(existingByGithubId) : null;
  const preserveManualPat = !!existingPat && !existingPat.startsWith("gho_");

  // An identity row keeps its email when the current GitHub email is held by
  // another row (typically the password account this identity was kept apart
  // from): the unique index would otherwise fail every later call.
  let updatedEmail = existingByGithubId?.email ?? null;
  if (existingByGithubId && githubEmail && githubEmail !== existingByGithubId.email) {
    const holder = await prisma.user.findUnique({ where: { email: githubEmail } });
    if (!holder) updatedEmail = githubEmail;
  }

  const user = existingByGithubId
    ? await prisma.user.update({
        where: { id: existingByGithubId.id },
        data: {
          githubLogin: githubUser.login,
          email: updatedEmail,
          // githubOwner/passwordHash stay untouched.
          ...(preserveManualPat ? {} : { githubPat: encryptGithubPat(githubAccessToken) }),
        },
      })
    : await prisma.user.create({
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
