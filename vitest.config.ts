import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    testTimeout: 30000, // Generous for integration tests
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Global floor — a couple of points below measured baseline so the
      // current suite passes while regressions fail.
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 57,
        lines: 60,
        // Per-file floors for files newly covered in this PR.
        // Floors are set a few points below measured values so the gate is
        // tight enough to catch regressions without failing on rounding.
        'app/api/auth/register/route.ts': { lines: 95, statements: 95, branches: 85 },
        'lib/db.ts': { lines: 95, statements: 95, branches: 78 },
        'app/api/dashboard/pat/route.ts': { lines: 85, statements: 85 },
        'app/api/dashboard/tokens/route.ts': { lines: 85, statements: 85 },
        // [id] directory — use wildcard to avoid bracket glob issues
        'app/api/dashboard/tokens/*/route.ts': { lines: 85, statements: 85 },
        'app/api/v1/publish/route.ts': { lines: 48, statements: 48 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
