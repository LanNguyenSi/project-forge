import "next-auth";

declare module "next-auth" {
  interface Session {
    // Mint time of the session (ms), see lib/session-cutoff.ts.
    authAt?: number;
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
    };
  }

  interface User {
    id: string;
    email: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    authAt?: number;
  }
}
