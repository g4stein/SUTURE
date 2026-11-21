import { defineConfig } from 'vite';

/**
 * One self-contained Node ESM file (Spec 05 §2.3). Core and runtime are TypeScript source and get bundled with every pure
 * JavaScript dependency; only DuckDB-WASM and Pyodide stay external, because they load their .wasm and stdlib files from
 * their own package directories.
 */
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'suture.mjs', banner: '#!/usr/bin/env node' } },
  },
  ssr: { target: 'node', noExternal: true, external: ['@duckdb/duckdb-wasm', 'pyodide'] },
});
