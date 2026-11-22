import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The packed-tarball smoke test needs the npm registry and runs separately (`pnpm test:pack`).
    exclude: [...configDefaults.exclude, 'test/**/*.pack.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
