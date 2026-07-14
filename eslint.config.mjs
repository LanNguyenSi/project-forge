import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next v15 still ships a legacy `extends`-shaped config, not
// a native flat-config array. FlatCompat is the official ESLint 9 bridge
// for that shape; see https://eslint.org/docs/latest/use/configure/migration-guide
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
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
];

export default eslintConfig;
