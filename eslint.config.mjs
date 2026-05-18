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
    // Pre-existing baseline drift inherited from the `next lint` → ESLint
    // CLI migration. The new `next/typescript` Strict ruleset is harsher
    // than the legacy `next lint` default; downgrading these rules to
    // warnings keeps the migration a no-op for the working tree while
    // preserving the signal. See follow-up task on agent-tasks for the
    // proper cleanup pass.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
