#!/usr/bin/env node
// Main-thread JavaScript budget (Spec 02 Req 10.2: <= 350 kB gzip, excluding workers). Run after `pnpm build`.
// The main thread loads the module scripts and module preloads that packages/web/dist/index.html references, plus the
// chunks they import statically. Worker chunks (`*.worker-*.js`) and the chunks only they import are excluded. Sizes are
// gzip level 9, the same measure Vite reports. Exits 1 when the total is over budget, 2 when the build is missing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 350 * 1000;
const dist = new URL('../packages/web/dist/', import.meta.url).pathname;
const html = join(dist, 'index.html');
if (!existsSync(html)) {
  console.error(`bundle-budget: ${html} not found; run pnpm build first`);
  process.exit(2);
}

const entries = [...readFileSync(html, 'utf8').matchAll(/<(?:script[^>]*\bsrc|link[^>]*rel="modulepreload"[^>]*\bhref)="\/([^"]+\.js)"/g)].map((m) => m[1]);
if (entries.length === 0) {
  console.error('bundle-budget: index.html references no JavaScript');
  process.exit(2);
}

// Follow static imports (`import … from "./x.js"`, `import "./x.js"`) between assets; dynamic import() is lazy.
const seen = new Set();
const queue = [...entries];
while (queue.length > 0) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const code = readFileSync(join(dist, rel), 'utf8');
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w${}\s,*]+\s*from\s*)?["']\.\/([^"']+\.js)["']/g)) {
    const dep = join(rel, '..', m[1]);
    if (!/\.worker-/.test(dep)) queue.push(dep);
  }
}

let total = 0;
for (const rel of [...seen].sort()) {
  const bytes = gzipSync(readFileSync(join(dist, rel)), { level: 9 }).length;
  total += bytes;
  console.log(`  ${rel}  ${(bytes / 1000).toFixed(2)} kB gzip`);
}
const verdict = total <= BUDGET_BYTES ? 'within' : 'OVER';
console.log(`bundle-budget: main-thread JavaScript ${(total / 1000).toFixed(2)} kB gzip, ${verdict} the ${BUDGET_BYTES / 1000} kB budget`);
process.exit(total <= BUDGET_BYTES ? 0 : 1);
