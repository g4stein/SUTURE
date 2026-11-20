import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Steering architecture-and-isolation.md §4: COOP same-origin + COEP credentialless everywhere (dev, preview, Vercel).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// duckdb-wasm ships its synchronous browser bindings but omits them from its package "exports" map.
const duckdbBlocking = fileURLToPath(new URL('./node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { 'duckdb-wasm-blocking': duckdbBlocking },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['pyodide', '@duckdb/duckdb-wasm'] },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders, port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
});
