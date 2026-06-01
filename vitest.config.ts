import { defineConfig } from 'vitest/config'

const DEFAULT_TEST_TIMEOUT = process.platform === 'win32' ? 30_000 : 15_000

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    maxWorkers: 4,
    // Heavy benchmark/install/runtime suites can exceed 15s on the slower
    // Windows CI leg under coverage even though they stay well below that on
    // macOS/Linux. Keep the tighter default elsewhere and give Windows enough
    // headroom to avoid timeout-only failures.
    testTimeout: DEFAULT_TEST_TIMEOUT,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 85,
        lines: 75,
      },
    },
  },
})
