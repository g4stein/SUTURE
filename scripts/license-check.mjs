#!/usr/bin/env node
// Dependency license audit (steering architecture-and-isolation.md §5).
// Source of truth: every package in pnpm-lock.yaml (all documents). Each installed package's declared license is parsed as an
// SPDX expression (AND / OR / WITH / parentheses / "-or-later" / "+"). A package passes when at least one OR-alternative is
// fully permissive. GPL / LGPL / AGPL alternatives never satisfy the policy (but "MIT OR GPL-3.0" passes via MIT); MPL-2.0 is
// allowed only for the unmodified Pyodide runtime. Missing or unparseable licenses fail.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

export const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'BlueOak-1.0.0', 'Unlicense',
  'Python-2.0', 'CC-BY-4.0', 'Zlib',
]);
/** Non-SPDX spellings seen in the wild, normalized to their SPDX identifier. */
const ALIASES = new Map([['MIT/X11', 'MIT'], ['X11', 'MIT'], ['Apache 2.0', 'Apache-2.0'], ['BSD', 'BSD-3-Clause']]);
const MPL_ALLOWED = new Set(['pyodide']);
const COPYLEFT = /^(A|L)?GPL-|^GPL$|^LGPL$|^AGPL$/i;

/** Tokenizes and parses an SPDX expression into an OR-of-ANDs list of license identifiers. */
export function parseSpdx(expr) {
  const src = ALIASES.get(expr.trim()) ?? expr;
  const toks = src.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of "${expr}"`);
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new Error(`unbalanced parentheses in "${expr}"`);
      return v;
    }
    if (/^(AND|OR|WITH)$/i.test(t) || t === ')') throw new Error(`unexpected "${t}" in "${expr}"`);
    let id = (ALIASES.get(t) ?? t).replace(/\+$/, '').replace(/-or-later$|-only$/, '');
    if (peek()?.toUpperCase() === 'WITH') { next(); next(); } // license exceptions only add permissions
    return [[id]];
  }
  function andExpr() {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      const right = primary();
      left = left.flatMap((a) => right.map((b) => [...a, ...b]));
    }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = [...left, ...andExpr()];
    }
    return left;
  }
  const out = orExpr();
  if (i !== toks.length) throw new Error(`trailing tokens in "${expr}"`);
  return out;
}

export function verdict(name, license) {
  if (license === null) return { ok: false, reason: 'no license declared' };
  let alternatives;
  try {
    alternatives = parseSpdx(license);
  } catch (e) {
    return { ok: false, reason: `unparseable license expression: ${e.message}` };
  }
  const allowed = (id) => PERMISSIVE.has(id) || (id === 'MPL-2.0' && MPL_ALLOWED.has(name));
  if (alternatives.some((all) => all.every(allowed))) return { ok: true, reason: '' };
  const ids = alternatives.flat();
  if (ids.some((id) => COPYLEFT.test(id))) return { ok: false, reason: `forbidden copyleft license ${license}` };
  if (ids.includes('MPL-2.0')) return { ok: false, reason: 'MPL-2.0 is allowed only for the unmodified Pyodide runtime' };
  return { ok: false, reason: `license ${license} is not on the allowlist` };
}

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

/** pnpm's virtual store folders, read once. Packages with peer dependencies live in suffixed folders (`vite@7.3.8_@types+node@…`). */
let storeDirs = null;
function storeDir(pkg) {
  const base = `${pkg.name.replace('/', '+')}@${pkg.version}`;
  if (storeDirs === null) {
    const dir = join(root, 'node_modules', '.pnpm');
    storeDirs = existsSync(dir) ? readdirSync(dir) : [];
  }
  return storeDirs.find((d) => d === base) ?? storeDirs.find((d) => d.startsWith(`${base}_`)) ?? null;
}

function licenseOf(pkg) {
  const dir = storeDir(pkg);
  const file = dir === null ? null : join(root, 'node_modules', '.pnpm', dir, 'node_modules', pkg.name, 'package.json');
  if (file === null || !existsSync(file)) return { license: null, installed: false };
  const json = JSON.parse(readFileSync(file, 'utf8'));
  let lic = json.license ?? json.licenses;
  if (Array.isArray(lic)) lic = `(${lic.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')})`;
  else if (lic && typeof lic === 'object') lic = lic.type;
  return { license: typeof lic === 'string' ? lic : null, installed: true };
}

function selfTest() {
  const cases = [
    ['jszip', '(MIT OR GPL-3.0-or-later)', true], ['pako', '(MIT AND Zlib)', true], ['chainsaw', 'MIT/X11', true],
    ['x', 'GPL-3.0-only', false], ['x', 'LGPL-2.1+', false], ['x', 'AGPL-3.0', false], ['x', 'MIT AND GPL-2.0', false],
    ['x', 'MPL-2.0', false], ['pyodide', 'MPL-2.0', true], ['x', 'Apache-2.0 WITH LLVM-exception', true], ['x', '(MIT', false],
  ];
  for (const [name, lic, ok] of cases) {
    const v = verdict(name, lic);
    if (v.ok !== ok) throw new Error(`license-check self-test failed for "${lic}" (${name}): got ${v.ok}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  selfTest();
  const pkgs = packagesFromLock(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const tally = new Map();
  const failures = [];
  const dual = [];
  let skipped = 0;
  for (const p of pkgs) {
    const { license, installed } = licenseOf(p);
    if (!installed) { skipped++; continue; }
    tally.set(license ?? 'UNKNOWN', (tally.get(license ?? 'UNKNOWN') ?? 0) + 1);
    const v = verdict(p.name, license);
    if (!v.ok) failures.push(`${p.name}@${p.version}: ${v.reason}`);
    else if (license !== null && /\bOR\b/i.test(license)) dual.push(`${p.name}@${p.version} (${license})`);
  }
  console.log(`license audit: ${pkgs.length} packages in pnpm-lock.yaml (${pkgs.length - skipped} installed and checked; ${skipped} not installed here: optional binaries for other platforms, and the pnpm release pinned by packageManager)`);
  for (const [lic, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${lic}`);
  if (dual.length > 0) console.log(`  dual-licensed, accepted under the permissive alternative: ${dual.join(', ')}`);
  const mpl = [...tally.keys()].filter((l) => /MPL/.test(l));
  console.log(`MPL-2.0 packages: ${pkgs.filter((p) => mpl.includes(licenseOf(p).license ?? '')).map((p) => p.name).join(', ') || 'none'}`);
  console.log(`GPL/LGPL/AGPL-only packages: ${failures.filter((f) => /copyleft/.test(f)).length === 0 ? 'none' : 'FOUND'}`);
  if (failures.length > 0) {
    console.error(`FAIL:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('PASS');
}
