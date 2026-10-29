/**
 * Mask GitHub credentials in free text before it is logged or returned.
 *
 * A failed `git push` to an authed remote echoes the URL (and so the token)
 * in git's stderr, and Prisma errors can embed argument values. Handles the
 * `x-access-token:TOKEN@` and `https://TOKEN@` remote forms, bare GitHub
 * token shapes (prefixed, or classic 40-hex only next to credential context
 * so a bare git SHA survives) as defense in depth.
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // Capped length (a token is far shorter than 256 characters): an
      // unbounded run backtracks quadratically on input that repeats
      // "x-access-token:" with no closing "@". The bare-token patterns below
      // still mask a longer token.
      .replace(/x-access-token:[^@\s/]{1,256}@/g, "x-access-token:***@")
      .replace(/https:\/\/[^@\s/]+@/g, "https://***@")
      // No leading word boundary on purpose: tokens pasted straight after a
      // word character (`my_ghp_...`, `tokenghp_...`, `x_github_pat_...`) are
      // still credentials. The price is over-masking any word that ends in a
      // prefix, e.g. `highs_traffic` masks as `highs_***`; an error log that
      // loses a substring to `***` is an acceptable failure mode next to
      // leaking a token.
      .replace(/(gho|ghp|ghu|ghs)_[A-Za-z0-9]+/g, "$1_***")
      .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
      // Unprefixed classic PATs are 40 lowercase hex, exactly a git commit
      // SHA, so masking them requires credential context (a `token`,
      // `Authorization`, `bearer`, `password`, `secret` or `x-access-token`
      // word, then an optional run of `=`, `:` or space separators); a bare
      // SHA in `git push` or `git log` output stays readable. The separator
      // run and the hex run are single disjoint quantifiers, so each anchor
      // fails in linear time like the capped pattern above.
      .replace(
        /\b(token|authorization|bearer|password|secret|x-access-token)([\s=:]*)([0-9a-f]{40,})/gi,
        "$1$2***",
      )
  );
}
