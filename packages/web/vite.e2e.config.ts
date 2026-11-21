import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';

/**
 * E2E-only build: the app plus e2e/harness (real workers wrapped in a fault injector). Output goes to dist-e2e/, never to
 * dist/, so the chaos entry points cannot ship. SUTURE_E2E_NO_ISOLATION=1 serves it without COOP/COEP to exercise the
 * not-isolated (terminate-and-respawn) path.
 */
const noIsolation = process.env['SUTURE_E2E_NO_ISOLATION'] === '1';
const headers = noIsolation ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };

const merged = mergeConfig(base, defineConfig({
  build: {
    outDir: 'dist-e2e',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        harness: fileURLToPath(new URL('./e2e/harness/index.html', import.meta.url)),
      },
    },
  },
}));

// mergeConfig deep-merges objects, so the base COOP/COEP headers must be replaced, not merged.
export default { ...merged, preview: { ...merged.preview, headers } };
