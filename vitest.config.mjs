import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    // The server and hook suites wait on the inject file's 500 ms poll, which the 5 s default does not leave room for.
    testTimeout: 20000,
  },
})
