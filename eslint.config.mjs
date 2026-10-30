import { defineConfig } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next v16 ships native flat-config arrays (and officially
// supports ESLint 10), so they are spread in directly; no FlatCompat bridge.
const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  {
    // Standalone CJS ops scripts (no ts-node/tsx dependency by design — see
    // scripts/backfill-api-token-hashes.js's header comment), run directly
    // via `node`, not part of the Next app's browser/TS bundle. Scoped
    // override rather than a blanket ignore, so they still get linted —
    // just with Node globals and CommonJS `require` allowed.
    files: ["scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // The settings page fetches its data when the session becomes
    // authenticated. `loadData` is shared with the save/create/revoke
    // handlers (it re-reads the page after each mutation), so it cannot move
    // into the effect, and the React Compiler rule reports the call as a
    // synchronous setState although every setState runs after an await. Only
    // this rule, only this file; the rest of react-hooks stays on.
    files: ["app/(dashboard)/settings/page.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
