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
        // Process wiring only.
        'src/cli/main.ts',
        'src/target/server.ts',
        // Runs inside the browser page, so v8 in Node cannot instrument it.
        // Verified by tests/surface/extraction-naming.test.ts instead.
        'src/surface/browser/extract.ts',
        'src/**/types.ts',
        'src/**/*.d.ts',
      ],
    },
  },
});
