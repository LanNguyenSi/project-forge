/**
 * Identity-broker registration endpoint.
 *
 * Contract (shared with agent-tasks, deploy-panel):
 *   POST /api/auth/register-from-project-pilot
 *   Body:     { githubAccessToken: string, githubLogin?: string }
 *   Response: { apiToken, userId, githubLogin }
 *   Errors:   401 invalid token / login mismatch
 *             503 GitHub unreachable
 *             400 missing fields
 *
 * project-forge does NOT blindly trust the caller (project-pilot). The
 * access-token is re-verified against `api.github.com/user`. A compromised
 * broker cannot impersonate users because the token has to be valid.
 *
 * The returned apiToken is project-forge's own `pf_*` API token — the broker
 * stores it encrypted and forwards it on subsequent API calls. Idempotent:
 * a second call for the same GitHub identity returns the existing active
 * token rather than minting a new one.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma, generateApiToken } from "@/lib/db";
import {
  fetchGitHubUser,
  GitHubAuthError,
  GitHubUnreachableError,
} from "@/lib/github";

interface RegisterBody {
  githubAccessToken: unknown;
  githubLogin?: unknown;
}

export async function POST(req: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body.githubAccessToken !== "string" || body.githubAccessToken.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "githubAccessToken is required" },
      { status: 400 },
    );
  }
  // Capture the validated token: control-flow narrowing on body.githubAccessToken
  // is lost across the GitHub-verification call below, so hold a typed const.
  const githubAccessToken: string = body.githubAccessToken;
  if (body.githubLogin !== undefined && typeof body.githubLogin !== "string") {
    return NextResponse.json(
      { error: "bad_request", message: "githubLogin must be a string if provided" },
      { status: 400 },
    );
  }

  let githubUser;
  try {
    githubUser = await fetchGitHubUser(githubAccessToken);
  } catch (err) {
    if (err instanceof GitHubAuthError) {
      return NextResponse.json(
        { error: "unauthorized", message: "GitHub access-token verification failed" },
        { status: 401 },
      );
    }
    if (err instanceof GitHubUnreachableError) {
      return NextResponse.json(
        {
          error: "upstream_unavailable",
          message: "Could not reach GitHub to verify access-token; retry shortly",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "internal", message: "Unexpected error verifying access-token" },
      { status: 500 },
    );
  }

  if (body.githubLogin && body.githubLogin !== githubUser.login) {
    return NextResponse.json(
      {
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

  // Email-collision guard: if the verified GitHub email matches a local-auth
  // account that has NO githubId yet, we refuse to silently merge the two.
  // Otherwise anyone who controls that email on GitHub could claim the local
  // account. Surface a structured 409 so project-pilot can prompt the user
  // to sign in locally first and link GitHub explicitly.
  if (!existingByGithubId && githubEmail) {
    const existingByEmail = await prisma.user.findUnique({ where: { email: githubEmail } });
    if (existingByEmail && !existingByEmail.githubId) {
      return NextResponse.json(
        {
          error: "account_exists_link_required",
          message:
            "An account with this email already exists. Sign in with your " +
            "existing credentials first, then link GitHub.",
        },
        { status: 409 },
      );
    }
  }

  const user = existingByGithubId
    ? await prisma.user.update({
        where: { id: existingByGithubId.id },
        data: {
          githubLogin: githubUser.login,
          email: githubEmail ?? existingByGithubId.email,
          // Backfill githubPat from the verified OAuth access-token, but only
          // when the user has none yet. This lets a project-pilot SSO user
          // publish (create + push repos) without a second GitHub step, while
          // never clobbering a classic PAT the user entered manually in the
          // forge dashboard. githubOwner/passwordHash stay untouched.
          ...(existingByGithubId.githubPat ? {} : { githubPat: githubAccessToken }),
        },
      })
    : await prisma.user.create({
        data: {
          githubId,
          githubLogin: githubUser.login,
          email: githubEmail,
          // Store the verified OAuth access-token as the GitHub PAT so a
          // project-pilot SSO user can publish immediately, without connecting
          // GitHub a second time on the forge side. pilot's OAuth requests the
          // `repo` scope, which is what createAndPushRepo needs.
          githubPat: githubAccessToken,
          // OAuth-provisioned users have no password; column is nullable.
        },
      });

  // Idempotency: reuse an existing unrevoked token for this user rather than
  // minting a new one on every broker call. The broker is expected to cache
  // the returned token and only re-register on 401.
  const activeToken = await prisma.apiToken.findFirst({
    where: { userId: user.id, revokedAt: null, name: "project-pilot" },
    orderBy: { createdAt: "desc" },
  });

  let apiToken: string;
  if (activeToken) {
    apiToken = activeToken.token;
  } else {
    apiToken = generateApiToken();
    await prisma.apiToken.create({
      data: {
        token: apiToken,
        name: "project-pilot",
        userId: user.id,
      },
    });
  }

  return NextResponse.json({
    apiToken,
    userId: user.id,
    githubLogin: githubUser.login,
  });
}
