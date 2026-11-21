import { defineConfig } from 'vite';

/**
 * One Node ESM file (Spec 05 §2.3). Core and runtime are bundled; the MCP SDK, zod, DuckDB-WASM, and Pyodide stay
 * external dependencies of this package (the engines load their .wasm files from their own package directories).
 */
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'suture-mcp.mjs', banner: '#!/usr/bin/env node' } },
  },
  ssr: { target: 'node', noExternal: true, external: ['@duckdb/duckdb-wasm', 'pyodide', '@modelcontextprotocol/server', 'zod'] },
});
