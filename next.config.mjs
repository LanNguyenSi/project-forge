import { readFileSync } from "node:fs";

// Single source of truth for the app version surfaced in the UI (e.g. the
// /styleguide footer). Read package.json at build time and expose only the
// version string as a public env var, so the full package.json (incl.
// devDependency names) never leaks into the client bundle.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  // Next 15.5 buffers (clones) every request body that passes through the
  // middleware up to this value before the route runs, and the middleware
  // matcher covers /api/v1/*, so the default 10 MiB lets the route-level
  // caps in lib/limits.ts be exceeded by the clone alone. Pin the clone
  // just above GENERATE_MAX_BODY_BYTES (lib/limits.ts, 601_712 bytes, the
  // largest route cap under /api/v1; +1 KiB headroom for wire framing), so
  // no /api/v1 body is buffered beyond the caps the routes enforce. The
  // number must stay above GENERATE_MAX_BODY_BYTES and within +64 KiB of
  // it; tests/unit/next-config-middleware-body.test.ts pins both bounds
  // against the constant, so raising the cap there without updating this
  // number fails that test. (.mjs cannot import the TS constant; the same
  // test pins MIDDLEWARE_BODY_CLONE_LIMIT_BYTES in lib/limits.ts equal to
  // it.) Above the limit Next truncates the cloned body instead of
  // rejecting it, so a chunked oversize body (no Content-Length) reaches
  // the route cut off; readJsonBody (lib/read-json-body.ts) recognises a
  // parse failure on a body ending within one socket chunk of this limit
  // and answers 413, as clients that send Content-Length get.
  experimental: {
    middlewareClientMaxBodySize: 602736,
  },
  // Baseline security headers on every route. X-Frame-Options + CSP
  // frame-ancestors close the clickjacking hole (framed /login could
  // otherwise trick a logged-in user into publishing or registering);
  // nosniff stops MIME confusion on error/served pages; the referrer
  // policy keeps full URLs from leaking to third-party origins.
  // frame-ancestors is the ONLY CSP directive on purpose: a fuller
  // CSP is out of scope here and would break the app's inline styles
  // and swagger-ui assets.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
