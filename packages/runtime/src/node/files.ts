import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isReplayArtifact, type ReplayArtifact } from '@suture/core';
import { validateDocument } from '../workbooks/validateDocument.ts';
import { flagshipById } from '../workbooks/registry.ts';
import { openFlagship } from '../headless/flagships.ts';
import { openWorkbook, type HeadlessHost, type Workbook } from '../headless/workbook.ts';
import { createNodeEngineHost, type NodeEngineHost } from './engines.ts';
import { NODE_VERSIONS, nodeClock, nodeCompressor, nodeHasher, randomSeed } from './adapters.ts';

/** Same limit as the web importer (Spec 04 Req 6.4). */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface NodeHeadless {
  readonly host: HeadlessHost;
  readonly engines: NodeEngineHost;
}

/** A headless host over lazily booted, in-process real engines. */
export function createNodeHeadless(): NodeHeadless {
  const engines = createNodeEngineHost();
  return { engines, host: { engine: { ...engines.deps, clock: nodeClock }, hasher: nodeHasher, compressor: nodeCompressor, versions: NODE_VERSIONS, randomSeed } };
}

/**
 * Resolves `path` (relative to `base`) and, when `root` is given, refuses anything that resolves outside it after
 * following symlinks (Spec 05 Req 3.6: MCP tool input is untrusted).
 */
export function resolveFile(path: string, base: string, root: string | null): { readonly path: string } | { readonly error: string } {
  const abs = isAbsolute(path) ? path : resolve(base, path);
  if (!existsSync(abs)) return { error: `no such file: ${path}` };
  const real = realpathSync(abs);
  if (root !== null) {
    const r = realpathSync(root);
    if (real !== r && !real.startsWith(r + sep)) return { error: `${path} is outside the workspace (${r})` };
  }
  const st = statSync(real);
  if (!st.isFile()) return { error: `${path} is not a file` };
  if (st.size > MAX_FILE_BYTES) return { error: `${path} is larger than 256 MiB` };
  return { path: real };
}

function readJson(path: string): { readonly value: unknown } | { readonly error: string } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (e) {
    return { error: `${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface LoadOptions {
  readonly trustPython: boolean;
  /** Relative paths resolve against this directory. */
  readonly base: string;
  /** When set, files must resolve inside this directory. */
  readonly root: string | null;
}

/** `flagship:1`, `flagship:2`, or a `.suture.json` path. */
export async function loadWorkbook(ref: string, opts: LoadOptions, host: HeadlessHost): Promise<Workbook | { readonly error: string }> {
  if (flagshipById(ref) !== null) return (await openFlagship(ref, host)) as Workbook;
  if (/^flagship:/i.test(ref.trim())) return { error: `unknown flagship "${ref}" (use flagship:1 or flagship:2)` };
  const f = resolveFile(ref, opts.base, opts.root);
  if ('error' in f) return f;
  const j = readJson(f.path);
  if ('error' in j) return j;
  const check = validateDocument(j.value);
  if (!check.ok) return { error: `${ref} is not a Suture workbook: ${check.path} ${check.message}` };
  return openWorkbook(ref, 'file', check.document, opts.trustPython, host);
}

export function loadReplayArtifact(path: string, opts: Pick<LoadOptions, 'base' | 'root'>): ReplayArtifact | { readonly error: string } {
  const f = resolveFile(path, opts.base, opts.root);
  if ('error' in f) return f;
  const j = readJson(f.path);
  if ('error' in j) return j;
  return isReplayArtifact(j.value) ? j.value : { error: `${path} is not a Suture replay artifact (format suture.replay, version 1)` };
}

const SKIP = new Set(['node_modules', 'dist', 'dist-e2e', 'test-results', 'playwright-report', 'coverage']);

/** `*.suture.json` files under `root` (relative, sorted), skipping hidden and build directories. */
export function findWorkbookFiles(root: string, limits: { readonly maxDepth: number; readonly maxFiles: number } = { maxDepth: 8, maxFiles: 500 }): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth || out.length >= limits.maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= limits.maxFiles) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.suture.json')) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root, 0);
  return out;
}
