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
        // Per-file floors for files covered by this PR (set a few points
        // below measured values — see test coverage report for measurements).
        // Measured: stmts 100, branches 90, funcs 100, lines 100
        'middleware.ts': { statements: 95, branches: 85, functions: 95, lines: 95 },
        // Measured: stmts 100, branches 95, lines 100; funcs 50 due to .catch(()=>{}) defensive cb
        'app/api/v1/generate/route.ts': { statements: 95, branches: 90, lines: 95 },
        // Measured: stmts 85, branches 54, funcs 60, lines 88
        'app/api/generate/route.ts': { statements: 80, branches: 50, functions: 55, lines: 83 },
        // Measured: stmts 75, branches 50, funcs 83, lines 83
        'lib/subprocess.ts': { statements: 70, branches: 45, functions: 78, lines: 78 },
        // Measured: stmts 39, branches 40, funcs 50, lines 39
        // Low because generateStructuredJson is deferred (needs OpenAI SDK mock)
        'lib/ai-provider.ts': { statements: 36, branches: 37, functions: 47, lines: 36 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
