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
};

export default nextConfig;
