import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    testTimeout: 30000,
    passWithNoTests: true,
    exclude: [
      'node_modules/**',
      '_legacy_*/**',
      '**/_legacy_*/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
