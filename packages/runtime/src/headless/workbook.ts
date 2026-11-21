import {
  createWorkbookEngine, NEVER_CANCELLED, parseCellKey, toCellKey, workbookHash,
  type CellKey, type Compressor, type EngineDeps, type ExorcistDeps, type Hasher, type ParsedCell, type RecalcResult, type SutureDocument,
  type WorkbookEngine,
} from '@suture/core';
import { gatedPyEngine } from '../bridge/gatedPy.ts';

/**
 * What a headless host provides (Spec 05 §2): the real engines behind the core ports, plus the hashing, compression,
 * version, and seed adapters. `@suture/runtime/node` builds one for Node; nothing in this module touches Node APIs.
 */
export interface HeadlessHost {
  readonly engine: EngineDeps;
  readonly hasher: Hasher;
  readonly compressor: Compressor;
  readonly versions: { readonly suture: string; readonly fastCheck: string };
  readonly randomSeed: () => number;
}

export type WorkbookSource = 'flagship' | 'file';
export type Dialect = 'literal' | 'formula' | 'sql' | 'py';
/** `none`: no `=PY()` cells; `trusted`: they run; `blocked`: they evaluate to #PY! without touching Pyodide. */
export type PythonStatus = 'none' | 'trusted' | 'blocked';

export interface Workbook {
  /** As the caller named it: `flagship:1`, or a path. */
  readonly ref: string;
  readonly source: WorkbookSource;
  /** Canonical form (the engine's `definition()`), so hashes match the web app's replay artifacts. */
  readonly document: SutureDocument;
  readonly hash: string;
  readonly python: PythonStatus;
  readonly pyCells: ReadonlyArray<CellKey>;
}

export interface WorkbookInfo {
  readonly ref: string;
  readonly title: string;
  readonly hash: string;
  readonly python: PythonStatus;
}

export const FULL_RECALC = { tieBreak: { kind: 'rowMajor' as const }, token: NEVER_CANCELLED, sliceMs: 0 };

export function dialectOf(p: ParsedCell | null): Dialect | null {
  if (p === null) return null;
  return p.dialect;
}

/**
 * Opens a document for headless use. Built-in flagships always run their Python. Any other workbook runs `=PY()` cells
 * only when the caller passes `trustPython` (CLI `--trust-python`, MCP `trustPython: true`): Pyodide under Node can reach
 * Node's built-in modules through its JavaScript bridge, so untrusted Python must never start (Spec 05 Req 4).
 */
export async function openWorkbook(ref: string, source: WorkbookSource, doc: SutureDocument, trustPython: boolean, host: HeadlessHost): Promise<Workbook> {
  const e = createWorkbookEngine(doc.workbook, host.engine);
  const workbook = e.definition();
  const pyCells: CellKey[] = [];
  for (const s of workbook.sheets) for (const c of s.cells) if (e.getParsed(c.key)?.dialect === 'py') pyCells.push(c.key);
  const document: SutureDocument = { ...doc, workbook };
  const python: PythonStatus = pyCells.length === 0 ? 'none' : source === 'flagship' || trustPython ? 'trusted' : 'blocked';
  return { ref, source, document, hash: await workbookHash(document, host.hasher), python, pyCells };
}

export function infoOf(wb: Workbook): WorkbookInfo {
  return { ref: wb.ref, title: wb.document.title, hash: wb.hash, python: wb.python };
}

/** Engine ports for this workbook: the trust gate wraps Python when it is blocked. */
export function engineDepsFor(wb: Workbook, host: HeadlessHost): EngineDeps {
  if (wb.python !== 'blocked') return host.engine;
  return { ...host.engine, py: gatedPyEngine(host.engine.py, () => true) };
}

export function exorcistDepsFor(wb: Workbook, host: HeadlessHost): ExorcistDeps {
  return { engine: engineDepsFor(wb, host), hasher: host.hasher, compressor: host.compressor, versions: host.versions };
}

/** A fully evaluated engine for the workbook (every engine request awaited). */
export async function evaluatedEngine(wb: Workbook, host: HeadlessHost): Promise<{ readonly engine: WorkbookEngine; readonly result: RecalcResult }> {
  const engine = createWorkbookEngine(wb.document.workbook, engineDepsFor(wb, host));
  const result = await engine.recalculateAll(FULL_RECALC);
  return { engine, result };
}

/** Resolves `Sheet!A1` (any sheet-name casing) to the workbook's key, or explains why it cannot. */
export function resolveCell(wb: Workbook, ref: string): { readonly key: CellKey } | { readonly error: string } {
  const c = parseCellKey(ref.trim());
  if (c === null) return { error: `"${ref}" is not a cell reference like Sheet1!A1` };
  const sheet = wb.document.workbook.sheets.find((s) => s.name.toUpperCase() === c.sheet.toUpperCase());
  if (sheet === undefined) return { error: `there is no sheet named "${c.sheet}" (sheets: ${wb.document.workbook.sheets.map((s) => s.name).join(', ')})` };
  return { key: toCellKey({ sheet: sheet.name, row: c.row, col: c.col }) };
}
