import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import { prisma } from "./db";
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

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
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
 *   1. A row with this githubId: that is the account. Token refreshed.
 *   2. No such row, but a row with this email:
 *      - it has a passwordHash (a local account) or another githubId: refused,
 *        the row is not touched and no token is written;
 *      - it has neither (a row an earlier GitHub-only sign-in created, before
 *        githubId was recorded here): claimed, githubId is set. Such a row can
 *        only come from the GitHub sign-in itself, because registration always
 *        sets a password.
 *   3. Neither: a new row is created with the identity.
 */
async function signInWithGithub(
  user: { id: string; email?: string | null },
  account: { providerAccountId: string; access_token?: string },
  profile: unknown,
): Promise<true | string> {
  const githubId = String(account.providerAccountId);
  const email = user.email ?? `github-${githubId}@noreply`;
  const githubUsername = (user as { login?: string }).login ?? email.split("@")[0];
  const login = (profile as { login?: unknown } | null | undefined)?.login;
  const githubLogin = typeof login === "string" && login ? login : undefined;
  const tokenFields = {
    githubPat: account.access_token,
    githubOwner: githubUsername,
    ...(githubLogin ? { githubLogin } : {}),
  };

  const byIdentity = await prisma.user.findUnique({ where: { githubId } });
  if (byIdentity) {
    await prisma.user.update({ where: { id: byIdentity.id }, data: tokenFields });
    user.id = byIdentity.id;
    return true;
  }

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
