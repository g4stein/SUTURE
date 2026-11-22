import { defineConfig } from 'vitest/config';

/** `pnpm test:pack`: the packed-tarball smoke test only (needs the npm registry; Spec 05 task 3.5). */
export default defineConfig({
  test: {
    include: ['test/**/*.pack.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
