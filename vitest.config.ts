import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // no unit tests here yet; the suites land with the features they cover
    passWithNoTests: true,
  },
})
