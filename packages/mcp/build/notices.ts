import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Build plugin for the published package (Spec 05 Req 3.10):
 * - writes `dist/THIRD_PARTY_LICENSES.md` from the modules Rollup actually bundled into `suture-mcp.mjs`, with each
 *   package's name, version, declared license, and full LICENSE and NOTICE texts (MIT and Apache-2.0 require shipping them);
 * - marks the bin executable.
 * Packages left external (installed by npm as dependencies) ship their own license files and are not listed.
 */
interface Bundled {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly dir: string;
}

const PACKAGE_DIR = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//;

function licenseOf(pkg: Record<string, unknown>): string {
  const l = pkg['license'] ?? pkg['licenses'];
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : String((x as { type?: unknown }).type))).join(' OR ');
  if (l !== null && typeof l === 'object') return String((l as { type?: unknown }).type);
  return 'UNKNOWN';
}

function noticeFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)(\.(md|txt))?$/i.test(f)).sort((a, b) => {
    const rank = (f: string): number => (/^notice/i.test(f) ? 1 : 0);
    return rank(a) - rank(b) || (a < b ? -1 : 1);
  });
}

export function thirdPartyNotices(opts: { readonly bin: string }): Plugin {
  const bundled = new Map<string, Bundled>();
  let outDir = 'dist';
  return {
    name: 'suture-third-party-notices',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    moduleParsed(info) {
      const m = PACKAGE_DIR.exec(info.id.replaceAll('\\', '/'));
      if (m === null || m[1] === undefined) return;
      const dir = m[1];
      if (bundled.has(dir)) return;
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) return;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      bundled.set(dir, { name: String(pkg['name']), version: String(pkg['version']), license: licenseOf(pkg), dir });
    },
    writeBundle() {
      const list = [...bundled.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const missing = list.filter((p) => noticeFiles(p.dir).length === 0).map((p) => p.name);
      if (missing.length > 0) this.error(`bundled packages without a LICENSE file: ${missing.join(', ')}`);
      const out: string[] = [
        '# Third-party licenses',
        '',
        `\`${opts.bin}\` bundles the following open-source packages. Their license and notice texts follow, as their licenses require.`,
        'Packages installed by npm as dependencies of this package (`@duckdb/duckdb-wasm`, `pyodide`, `@modelcontextprotocol/server`, `zod`, and their dependencies) ship their own license files.',
        '',
        '| Package | Version | License |',
        '|---|---|---|',
        ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
      ];
      for (const p of list) {
        out.push('', '---', '', `## ${p.name} ${p.version}`, '', `License: ${p.license}`);
        for (const f of noticeFiles(p.dir)) out.push('', `### ${f}`, '', '```text', readFileSync(join(p.dir, f), 'utf8').trimEnd(), '```');
      }
      writeFileSync(join(outDir, 'THIRD_PARTY_LICENSES.md'), `${out.join('\n')}\n`);
      chmodSync(join(outDir, opts.bin), 0o755);
    },
  };
}
