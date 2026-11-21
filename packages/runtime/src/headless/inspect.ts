import {
  compareRowMajor, createWorkbookEngine, MinHeap, parseCellKey, printFormula,
  type CellKey, type FormulaAst, type ParsedCell, type WorkbookEngine,
} from '@suture/core';
import { toJson, type JsonValue } from './json.ts';
import { dialectOf, infoOf, resolveCell, type Dialect, type HeadlessHost, type Workbook, type WorkbookInfo } from './workbook.ts';

export type ParsedJson =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'formula'; readonly printed: string; readonly ast: FormulaAst }
  | { readonly kind: 'formulaError'; readonly offset: number; readonly message: string }
  | { readonly kind: 'sql'; readonly template: string; readonly slots: ReadonlyArray<{ readonly placeholder: string; readonly ref: string }>; readonly error: string | null }
  | { readonly kind: 'py'; readonly code: string; readonly vectorized: boolean; readonly inputs: ReadonlyArray<string> };

export interface LineageReport {
  readonly format: 'suture.lineage';
  readonly version: 1;
  readonly workbook: WorkbookInfo;
  readonly cell: CellKey;
  readonly exists: boolean;
  readonly dialect: Dialect | null;
  readonly raw: string | null;
  readonly parsed: ParsedJson | null;
  /** Direct precedents and dependents, row-major. */
  readonly precedents: ReadonlyArray<CellKey>;
  readonly dependents: ReadonlyArray<CellKey>;
  /** Every transitive precedent, in topological order (sources first). */
  readonly upstream: ReadonlyArray<CellKey>;
  /** Every transitive dependent, in topological order. */
  readonly downstream: ReadonlyArray<CellKey>;
  /** upstream, the cell, and downstream as one topological order: the cell's full evaluation chain. */
  readonly chain: ReadonlyArray<CellKey>;
  /** Chain cells on a reference cycle; they cannot be ordered and are listed row-major at the end of `chain`. */
  readonly cyclic: ReadonlyArray<CellKey>;
  readonly dialects: Readonly<Record<string, Dialect>>;
}

function parsedJson(p: ParsedCell | null): ParsedJson | null {
  if (p === null) return null;
  switch (p.dialect) {
    case 'literal': return { kind: 'literal', value: toJson(p.value) };
    case 'formula': return 'parseError' in p ? { kind: 'formulaError', offset: p.parseError.offset, message: p.parseError.message } : { kind: 'formula', printed: `=${printFormula(p.ast)}`, ast: p.ast };
    case 'sql': return { kind: 'sql', template: p.template.text, slots: p.template.slots.map((s) => ({ placeholder: s.placeholder, ref: s.ref.text })), error: p.template.error ?? null };
    case 'py': return { kind: 'py', code: p.program.code, vectorized: p.program.vectorized, inputs: p.program.inputKeys.map((k) => k.key) };
  }
}

/** Transitive closure from `start` along `next`, excluding `start` itself unless it lies on a cycle. */
function reach(start: CellKey, next: (k: CellKey) => ReadonlyArray<CellKey>): Set<CellKey> {
  const seen = new Set<CellKey>();
  const stack = [...next(start)];
  while (stack.length > 0) {
    const k = stack.pop() as CellKey;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const n of next(k)) if (!seen.has(n)) stack.push(n);
  }
  return seen;
}

/** Kahn over the induced subgraph, ties row-major; cells left over sit on a cycle. */
function topological(e: WorkbookEngine, nodes: ReadonlySet<CellKey>, sheets: ReadonlyArray<string>): { readonly order: CellKey[]; readonly cyclic: CellKey[] } {
  const coord = (k: CellKey) => parseCellKey(k) ?? { sheet: '', row: 0, col: 0 };
  const cmp = (a: CellKey, b: CellKey): number => compareRowMajor(coord(a), coord(b), sheets);
  const indeg = new Map<CellKey, number>();
  for (const k of nodes) indeg.set(k, e.precedents(k).filter((p) => nodes.has(p) && p !== k).length);
  const heap = new MinHeap<CellKey>(cmp);
  for (const [k, n] of indeg) if (n === 0) heap.push(k);
  const order: CellKey[] = [];
  for (let k = heap.pop(); k !== undefined; k = heap.pop()) {
    order.push(k);
    for (const d of e.dependents(k)) {
      if (!nodes.has(d) || d === k) continue;
      const n = (indeg.get(d) ?? 0) - 1;
      indeg.set(d, n);
      if (n === 0) heap.push(d);
    }
  }
  const placed = new Set(order);
  return { order, cyclic: [...nodes].filter((k) => !placed.has(k)).sort(cmp) };
}

/**
 * A cell's dialect, source, parsed form, and lineage (Spec 05 Req 2.4 / 3.2). Static: built from the dependency graph,
 * so no engine boots.
 */
export function inspectLineage(wb: Workbook, cellRef: string, host: HeadlessHost): LineageReport | { readonly error: string } {
  const r = resolveCell(wb, cellRef);
  if ('error' in r) return r;
  const k = r.key;
  const e = createWorkbookEngine(wb.document.workbook, host.engine);
  const parsed = e.getParsed(k);
  const source = wb.document.workbook.sheets.flatMap((s) => s.cells).find((c) => c.key === k) ?? null;
  const sheets = wb.document.workbook.sheets.map((s) => s.name);
  const up = reach(k, (x) => e.precedents(x));
  const down = reach(k, (x) => e.dependents(x));
  const all = new Set<CellKey>([...up, k, ...down]);
  const { order, cyclic } = topological(e, all, sheets);
  const chain = [...order, ...cyclic];
  const dialects: Record<string, Dialect> = {};
  for (const c of chain) {
    const d = dialectOf(e.getParsed(c));
    if (d !== null) dialects[c] = d;
  }
  return {
    format: 'suture.lineage', version: 1, workbook: infoOf(wb), cell: k, exists: parsed !== null, dialect: dialectOf(parsed),
    raw: source?.raw ?? null, parsed: parsedJson(parsed),
    precedents: [...e.precedents(k)], dependents: [...e.dependents(k)],
    upstream: chain.filter((c) => up.has(c) && c !== k), downstream: chain.filter((c) => down.has(c) && c !== k),
    chain, cyclic, dialects,
  };
}
