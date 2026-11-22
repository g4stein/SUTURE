import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAAS_NOTES } from '@suture/runtime/workbooks';
import { callTool, freshSeed, StdioClient, TOOLS } from './rpc.ts';

/**
 * Spec 05 Req 3.10 / task 3.5 — the package exactly as npm users get it. Packs the built package with pnpm (which
 * rewrites workspace: specifiers), installs the tarball with npm into a temporary project outside the monorepo, and runs
 * the installed `suture-mcp` bin over stdio. Needs the npm registry; it runs as `pnpm --filter @g4stein/suture-mcp
 * test:pack`, a separate CI step, so `pnpm test` stays offline-friendly.
 */
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO = realpathSync(resolve(PKG_DIR, '../..'));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'suture-mcp-pack-')));
const project = join(work, 'consumer');

type Manifest = Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

let tarball = '';
let installed = '';
let client: StdioClient | null = null;

function run(cmd: string, args: ReadonlyArray<string>, cwd: string): string {
  return execFileSync(cmd, [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Every installed package directory under node_modules (scoped and nested), as [dir, manifest]. */
function packages(nodeModules: string): Array<[string, Manifest]> {
  const out: Array<[string, Manifest]> = [];
  const visit = (dir: string): void => {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) out.push([dir, JSON.parse(readFileSync(manifest, 'utf8')) as Manifest]);
    if (existsSync(join(dir, 'node_modules'))) walk(join(dir, 'node_modules'));
  };
  const walk = (nm: string): void => {
    for (const e of readdirSync(nm)) {
      if (e.startsWith('.')) continue;
      if (e.startsWith('@')) for (const s of readdirSync(join(nm, e))) visit(join(nm, e, s));
      else visit(join(nm, e));
    }
  };
  walk(nodeModules);
  return out;
}

beforeAll(() => {
  run('pnpm', ['pack', '--pack-destination', work], PKG_DIR);
  tarball = join(work, 'g4stein-suture-mcp-0.1.0.tgz');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'suture-mcp-consumer', version: '0.0.0', private: true }, null, 2)}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], project);
  installed = join(project, 'node_modules', '@g4stein', 'suture-mcp');
}, 600_000);

afterAll(() => client?.close());

describe('the packed tarball', () => {
  it('contains exactly the published files, with an executable bin', () => {
    const listing = run('tar', ['-tzvf', tarball], work).trim().split('\n');
    const files = listing.map((l) => l.split(/\s+/).at(-1) ?? '').sort();
    expect(files).toEqual(['package/LICENSE', 'package/README.md', 'package/dist/THIRD_PARTY_LICENSES.md', 'package/dist/suture-mcp.mjs', 'package/package.json']);
    expect(listing.find((l) => l.endsWith('package/dist/suture-mcp.mjs'))).toMatch(/^-rwxr-xr-x/);
    expect(readFileSync(join(installed, 'dist', 'suture-mcp.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(join(installed, 'dist', 'suture-mcp.mjs')).mode & 0o111).not.toBe(0);
  });

  it('declares a public MIT package whose runtime dependencies are only real npm packages', () => {
    const m = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as Manifest;
    expect(m).toMatchObject({ name: '@g4stein/suture-mcp', version: '0.1.0', license: 'MIT', publishConfig: { access: 'public' }, bin: { 'suture-mcp': './dist/suture-mcp.mjs' } });
    expect(m['private']).toBeUndefined();
    expect(Object.keys(m.dependencies ?? {}).sort()).toEqual(['@duckdb/duckdb-wasm', '@modelcontextprotocol/server', 'pyodide', 'zod']);
    expect(JSON.stringify(m)).not.toContain('workspace:');
    const notices = readFileSync(join(installed, 'dist', 'THIRD_PARTY_LICENSES.md'), 'utf8');
    for (const p of ['apache-arrow', 'fast-check', 'pure-rand', '@formulajs/formulajs', 'flatbuffers', 'bessel', 'jstat', 'tslib']) expect(notices).toContain(`## ${p} `);
    expect(notices).toContain('### NOTICE.txt');
  });

  it('installs with no path into the monorepo and no @suture workspace package', () => {
    const nm = join(project, 'node_modules');
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) {
          const target = realpathSync(p);
          if (target === REPO || target.startsWith(REPO + sep)) offenders.push(`${relative(project, p)} -> ${target}`);
        } else if (st.isDirectory()) scan(p);
      }
    };
    scan(nm);
    expect(offenders).toEqual([]);
    expect(existsSync(join(nm, '@suture'))).toBe(false);
    expect(realpathSync(installed).startsWith(work)).toBe(true);
  });

  it('every npm-resolved package passes the repository license policy', async () => {
    const policy = pathToFileURL(join(REPO, 'scripts', 'license-check.mjs')).href;
    const { verdict } = (await import(policy)) as { verdict: (name: string, license: string | null) => { ok: boolean; reason: string } };
    const failures: string[] = [];
    const mpl: string[] = [];
    const all = packages(join(project, 'node_modules'));
    for (const [, m] of all) {
      const raw = m['license'] ?? m['licenses'];
      const license = typeof raw === 'string' ? raw : Array.isArray(raw) ? `(${raw.map((l) => (typeof l === 'string' ? l : String((l as { type?: unknown }).type))).join(' OR ')})` : raw !== null && typeof raw === 'object' ? String((raw as { type?: unknown }).type) : null;
      const v = verdict(String(m['name']), license);
      if (!v.ok) failures.push(`${String(m['name'])}@${String(m['version'])}: ${v.reason}`);
      if (license !== null && /MPL/.test(license)) mpl.push(String(m['name']));
    }
    console.info(`[pack] npm installed ${all.length} packages; MPL-2.0: ${[...new Set(mpl)].join(', ') || 'none'}`);
    expect(failures).toEqual([]);
    expect([...new Set(mpl)]).toEqual(['pyodide']);
  });

  it('the installed bin serves MCP over stdio: tools/list and suture_run_audit on flagship:1', async () => {
    const bin = join(project, 'node_modules', '.bin', 'suture-mcp');
    client = new StdioClient(bin, [], project);
    const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '1' } });
    expect(init.result, client.stderr).toMatchObject({ serverInfo: { name: 'suture', version: '0.1.0' } });
    client.notify('notifications/initialized');
    const list = await client.request('tools/list');
    expect(((list.result?.['tools'] as Array<{ name: string }>) ?? []).map((t) => t.name).sort()).toEqual(TOOLS);
    const t0 = performance.now();
    const audit = await callTool(client, 'suture_run_audit', { workbook: 'flagship:1', seed: freshSeed() });
    console.info(`[pack] suture_run_audit flagship:1 from the installed tarball: ${Math.round(performance.now() - t0)} ms (includes engine boot)`);
    expect(audit.isError, `${audit.text}\n${client.stderr}`).toBe(false);
    expect(audit.structured).toMatchObject({ verdict: 'violated', violation: { id: SAAS_NOTES.expectedAssertion } });
    expect(client.stderr).toContain(`workspace ${project}`);
    expect(client.noise).toEqual([]);
  });
});
