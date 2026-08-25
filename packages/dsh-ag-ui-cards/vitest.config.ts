import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'happy-dom',
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
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
