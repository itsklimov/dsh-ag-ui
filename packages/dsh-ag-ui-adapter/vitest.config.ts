import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    // spawning a micro-host boots a real Cordis loader in a child process
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // the host bootstrap runs only inside the spawned child process; the
      // end-to-end specs in tests/agent.spec.ts exercise it there
      exclude: ['src/host-boot.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
