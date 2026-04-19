import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import { prisma } from "./db";
import bcrypt from "bcryptjs";

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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });
        // OAuth-only users have no passwordHash — treat them as
        // non-local-auth to avoid leaking account existence.
        if (!user || !user.passwordHash || !user.email) return null;
        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) return null;
        return { id: user.id, email: user.email };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "github") {
        // Upsert user with GitHub OAuth token
        const email = user.email ?? `github-${account.providerAccountId}@noreply`;
        const githubUsername = (user as { login?: string }).login ?? 
          email.split("@")[0];
        
        await prisma.user.upsert({
          where: { email },
          update: {
            githubPat: account.access_token,
            githubOwner: githubUsername,
          },
          create: {
            email,
            // OAuth users have no local password. passwordHash stays null so
            // the Credentials provider's `!user.passwordHash` guard can
            // reject them cleanly without a sentinel-string collision.
            passwordHash: null,
            githubPat: account.access_token,
            githubOwner: githubUsername,
          },
        });
        // Set user.id for JWT
        const dbUser = await prisma.user.findUnique({ where: { email } });
        if (dbUser) user.id = dbUser.id;
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
