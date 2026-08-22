import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Every suite boots the service against its own scratch database: migrations and Better Auth make
    // the first hook of a file slow, and the tests themselves talk to Postgres.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Suites run in parallel but each one holds a Postgres pool, so keep the fan-out modest.
    maxWorkers: 4,
    minWorkers: 1,
    env: { NODE_ENV: 'test', LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
