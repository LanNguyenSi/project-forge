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
