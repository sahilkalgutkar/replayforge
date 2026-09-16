import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        // Just starts the two servers.
        'src/target/server.ts',
        // Runs inside the browser page, so v8 in Node can't instrument it.
        // Covered by tests/surface/extraction-naming.test.ts instead.
        'src/surface/browser/extract.ts',
        // Types only.
        'src/surface/types.ts',
      ],
    },
  },
});
