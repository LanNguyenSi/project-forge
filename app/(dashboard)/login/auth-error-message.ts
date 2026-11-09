// NextAuth redirects a failed sign-in to the sign-in page with
// `?error=<code>` (this app sets `pages.signIn` to /login and no `pages.error`).
// The code is untrusted query input: it only selects one of these fixed
// messages and is never rendered itself.
const AUTH_ERROR_MESSAGES = new Map<string, string>([
  [
    "OAuthSignin",
    "Could not start the GitHub sign-in. Please try again, or sign in with email and password.",
  ],
  [
    "OAuthCallback",
    "The GitHub sign-in did not complete. Please try again, or sign in with email and password.",
  ],
  [
    "OAuthAccountNotLinked",
    "This email address is already registered with a different sign-in method. Sign in the way you did before.",
  ],
  ["CredentialsSignin", "Invalid email or password"],
  ["AccessDenied", "Access denied. This account is not allowed to sign in."],
  ["Callback", "Sign-in failed while setting up your account. Please try again."],
]);

const GENERIC_AUTH_ERROR_MESSAGE = "Sign-in failed. Please try again.";

/**
 * Maps the `error` query value of the login page to a human message.
 * Returns null when there is no error (absent or empty); an unknown code gets
 * the generic message.
 */
export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES.get(code) ?? GENERIC_AUTH_ERROR_MESSAGE;
}
