import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import { prisma } from "./db";
import { githubEmailStatus, githubPrimaryVerifiedEmail } from "./github-verified-email";
import bcrypt from "bcryptjs";
import {
  clientAddressFromHeaders,
  consumeSignInAttempt,
  emailLimiterKey,
  releaseSignInAttempt,
} from "./signin-rate-limit";

// Where a refused GitHub sign-in lands. The login page maps this code to a
// fixed message ("already registered with a different sign-in method"); the
// reason for the refusal is never put in the URL.
const GITHUB_SIGN_IN_REFUSED = "/login?error=OAuthAccountNotLinked";

// Where a GitHub sign-in lands when GitHub could not be asked about the email
// (the login page maps this code to "Sign-in failed ... Please try again").
// Nothing was written, so the retry decides.
const GITHUB_SIGN_IN_FAILED = "/login?error=Callback";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

/**
 * The email a new or claimed row is keyed on, or null when GitHub could not be
 * asked. Every row that is created or claimed goes through this: a non-null
 * result is an address GitHub lists as verified for the account, or the
 * placeholder, and the placeholder is returned only after GitHub gave a
 * definite answer (the reported address is not verified, or the account has no
 * verified primary address). An inconclusive lookup is always null.
 */
async function resolveGithubEmail(
  reported: string | null | undefined,
  accessToken: string | undefined,
  placeholder: string,
): Promise<string | null> {
  if (reported) {
    const status = await githubEmailStatus(accessToken, reported);
    if (status === "unknown") return null;
    return status === "verified" ? reported : placeholder;
  }
  const primary = await githubPrimaryVerifiedEmail(accessToken);
  if (primary.status === "unknown") return null;
  return primary.status === "found" ? primary.email : placeholder;
}

/**
 * GitHub sign-in: find the local user for this GitHub identity and store the
 * OAuth token on it. Returns true to let the sign-in continue, or the redirect
 * target of a refusal.
 *
 * The identity is the stable GitHub account id (`account.providerAccountId`,
 * stored in `User.githubId`), never the email alone: `POST /api/auth/register`
 * does not verify the email, so an email match says nothing about who owns the
 * row. Matching rules, in order:
 *   1. A row with this githubId: that is the account. Token refreshed. The
 *      email is not looked at and GitHub is not asked about it.
 *   2. No such row: the email the row is keyed on comes from
 *      `resolveGithubEmail`, which only trusts what GitHub itself lists for the
 *      account (`GET /user/emails`; the NextAuth GitHub provider fills
 *      `user.email` without checking `verified`, and leaves it empty when its
 *      own call failed). Three outcomes:
 *      - a verified address: the reported email if GitHub lists it as
 *        verified, or, when none was reported, the account's verified primary
 *        address;
 *      - a definite "no verified address" (the reported email is not verified,
 *        or the account has no verified primary address): the placeholder
 *        `github-<id>@noreply`, so an unverified address never claims,
 *        collides with or refuses on a real person's row;
 *      - unknown (the lookup could not be completed: no token, network error,
 *        timeout, non-200, bad body): the sign-in fails with
 *        GITHUB_SIGN_IN_FAILED and nothing is written, so a retry can still
 *        claim the legacy row. A placeholder row would bind the githubId to a
 *        new account for good.
 *      Then the row with the resulting email, if any:
 *      - it has a passwordHash (a local account) or another githubId: refused,
 *        the row is not touched and no token is written;
 *      - it has neither (a row an earlier GitHub-only sign-in created, before
 *        githubId was recorded here): claimed, githubId is set. Such a row can
 *        only come from the GitHub sign-in itself, because registration always
 *        sets a password.
 *   3. Neither: a new row is created with the identity, under the verified
 *      email or the placeholder.
 */
async function signInWithGithub(
  user: { id: string; email?: string | null },
  account: { providerAccountId: string; access_token?: string },
  profile: unknown,
): Promise<true | string> {
  const githubId = String(account.providerAccountId);
  const placeholderEmail = `github-${githubId}@noreply`;
  const login = (profile as { login?: unknown } | null | undefined)?.login;
  const githubLogin = typeof login === "string" && login ? login : undefined;
  // The GitHub login is the owner name; an email local part is only a last
  // resort for a new row, and an existing identity row keeps its owner unless
  // a login says otherwise, so the value does not flip between sign-ins.
  const ownerFromLogin = (user as { login?: string }).login ?? githubLogin;
  const tokenFieldsFor = (email: string) => ({
    githubPat: account.access_token,
    githubOwner: ownerFromLogin ?? email.split("@")[0],
    ...(githubLogin ? { githubLogin } : {}),
  });

  const byIdentity = await prisma.user.findUnique({ where: { githubId } });
  if (byIdentity) {
    await prisma.user.update({
      where: { id: byIdentity.id },
      data: {
        githubPat: account.access_token,
        ...(ownerFromLogin ? { githubOwner: ownerFromLogin } : {}),
        ...(githubLogin ? { githubLogin } : {}),
      },
    });
    user.id = byIdentity.id;
    return true;
  }

  const email = await resolveGithubEmail(user.email, account.access_token, placeholderEmail);
  // Could not ask GitHub: write nothing, a retry decides.
  if (email === null) return GITHUB_SIGN_IN_FAILED;
  const tokenFields = tokenFieldsFor(email);

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    if (byEmail.passwordHash || byEmail.githubId) return GITHUB_SIGN_IN_REFUSED;
    // Conditional write: the row must still be unlinked and password-less when
    // it is claimed, so a change between the read and the write cannot hand
    // the token to a different kind of account.
    try {
      const claimed = await prisma.user.updateMany({
        where: { id: byEmail.id, githubId: null, passwordHash: null },
        data: { githubId, ...tokenFields },
      });
      if (claimed.count !== 1) return GITHUB_SIGN_IN_REFUSED;
    } catch (error) {
      // Another row got this githubId between the identity lookup and the
      // write. Refuse with the fixed redirect: a thrown Prisma error would put
      // its message into the error URL.
      if (isUniqueViolation(error)) return GITHUB_SIGN_IN_REFUSED;
      throw error;
    }
    user.id = byEmail.id;
    return true;
  }

  try {
    const created = await prisma.user.create({
      data: {
        email,
        // OAuth users have no local password. passwordHash stays null so
        // the Credentials provider's `!user.passwordHash` guard can
        // reject them cleanly without a sentinel-string collision.
        passwordHash: null,
        githubId,
        ...tokenFields,
      },
    });
    user.id = created.id;
    return true;
  } catch (error) {
    // A concurrent sign-in created the row first; refuse, the retry matches it.
    if (isUniqueViolation(error)) return GITHUB_SIGN_IN_REFUSED;
    throw error;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_ID ?? "",
      clientSecret: process.env.GITHUB_SECRET ?? "",
      authorization: {
        params: { scope: "repo workflow user:email" },
      },
    }),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;
        // Failed attempts are limited per submitted email (the exact string,
        // as the lookup matches it) and per client address
        // (lib/signin-rate-limit.ts). The attempt is counted here, before any
        // await, and handed back on success. A refusal returns null like any
        // failed sign-in, before the database read and the bcrypt run, and is
        // the same for known and unknown emails.
        const emailKey = emailLimiterKey(credentials.email);
        const address = clientAddressFromHeaders(req?.headers);
        if (!consumeSignInAttempt(emailKey, address)) return null;
        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });
        // OAuth-only users have no passwordHash — treat them as
        // non-local-auth to avoid leaking account existence.
        if (!user || !user.passwordHash || !user.email) return null;
        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) return null;
        releaseSignInAttempt(emailKey, address);
        return { id: user.id, email: user.email };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "github") {
        return signInWithGithub(user, account, profile);
      }
      return true;
    },
    jwt({ token, user, account }) {
      if (user) token.userId = user.id;
      if (account?.provider === "github") {
        token.githubAccessToken = account.access_token;
      }
      return token;
    },
    session({ session, token }) {
      if (token.userId) session.user.id = token.userId as string;
      return session;
    },
  },
};
