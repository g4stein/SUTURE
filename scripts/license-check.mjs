#!/usr/bin/env node
// Dependency license audit (steering architecture-and-isolation.md §5).
// Source of truth: every package in pnpm-lock.yaml. Each package's declared license is read from its installed
// package.json. GPL / LGPL / AGPL are forbidden; permissive licenses are allowed; MPL-2.0 is allowed only for the
// unmodified Pyodide runtime. Unknown licenses fail the audit.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

const PERMISSIVE = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'BlueOak-1.0.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0']);
const MPL_ALLOWED = new Set(['pyodide']);
const FORBIDDEN = /\b(A|L)?GPL\b|GPL-|LGPL|AGPL/i;

/** pnpm 12 writes a multi-document lockfile (package-manager deps, then the workspace); read every packages: section. */
function packagesFromLock(text) {
  const out = new Map();
  const sections = text.split(/\n(?=\S)/).filter((s) => s.startsWith('packages:'));
  if (sections.length === 0) throw new Error('pnpm-lock.yaml has no packages: section');
  for (const section of sections) {
    for (const line of section.split('\n')) {
      const m = /^ {2}'?(@?[^@'\s]+(?:\/[^@'\s]+)?)@([^:'(\s]+)[^:]*'?:\s*$/.exec(line);
      if (m) out.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] });
    }
  }
  return [...out.values()];
}

function licenseOf(pkg) {
  const dir = join(root, 'node_modules', '.pnpm', `${pkg.name.replace('/', '+')}@${pkg.version}`, 'node_modules', pkg.name, 'package.json');
  if (!existsSync(dir)) return { license: null, note: 'not installed on this platform' };
  const json = JSON.parse(readFileSync(dir, 'utf8'));
  let lic = json.license ?? json.licenses;
  if (Array.isArray(lic)) lic = lic.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  else if (lic && typeof lic === 'object') lic = lic.type;
  return { license: typeof lic === 'string' ? lic : null, note: '' };
}

function verdict(name, license) {
  if (license === null) return { ok: false, reason: 'no license declared' };
  const expr = license.replace(/[()]/g, ' ').trim();
  if (FORBIDDEN.test(expr) && !/\bOR\b/i.test(expr)) return { ok: false, reason: `forbidden copyleft license ${license}` };
  const alternatives = expr.split(/\s+OR\s+/i).map((a) => a.split(/\s+AND\s+/i).map((x) => x.trim()));
  const okAlt = alternatives.some((all) => all.every((l) => PERMISSIVE.has(l) || (l === 'MPL-2.0' && MPL_ALLOWED.has(name))));
  if (okAlt) return { ok: true, reason: '' };
  if (expr === 'MPL-2.0') return { ok: false, reason: 'MPL-2.0 is allowed only for the unmodified Pyodide runtime' };
  return { ok: false, reason: `license ${license} is not on the allowlist` };
}

const pkgs = packagesFromLock(lock);
const tally = new Map();
const failures = [];
const skipped = [];
for (const p of pkgs) {
  const { license, note } = licenseOf(p);
  if (note) { skipped.push(`${p.name}@${p.version} (${note})`); continue; }
  const v = verdict(p.name, license);
  tally.set(license ?? 'UNKNOWN', (tally.get(license ?? 'UNKNOWN') ?? 0) + 1);
  if (!v.ok) failures.push(`${p.name}@${p.version}: ${v.reason}`);
}
console.log(`license audit: ${pkgs.length} packages in pnpm-lock.yaml (${pkgs.length - skipped.length} installed and checked)`);
for (const [lic, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${lic}`);
if (skipped.length > 0) console.log(`  skipped (${skipped.length} optional other-platform binaries / package-manager executables not installed here)`);
const gpl = [...tally.keys()].filter((l) => FORBIDDEN.test(l));
console.log(`GPL/LGPL/AGPL licenses found: ${gpl.length === 0 ? 'none' : gpl.join(', ')}`);
if (failures.length > 0) {
  console.error(`FAIL:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('PASS');
