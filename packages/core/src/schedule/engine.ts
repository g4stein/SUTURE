import {
  formatSheet, isValidSheetName, parseCellKey, rangeContains, toCellKey,
  type CellCoord, type CellKey, type NamedParameter, type RangeCoord,
} from '../model/address.ts';
import { isCellError, makeError, type CellError, type CellValue, type ScalarValue, type TableRef } from '../model/values.ts';
import { literalDisplay, type CellSource, type DatasetMeta, type Edit, type WorkbookDefinition } from '../model/workbook.ts';
import { assertCanonical, normalizeNumber } from '../boundary/normalize.ts';
import { parseCell, type ParsedCell } from '../parse/dialect.ts';
import type { ParseContext, ResolvedRef } from '../parse/ast.ts';
import { evaluateFormula, type EvalArg } from '../functions/evaluator.ts';
import { MinHeap, shortestCycle, stronglyConnected } from '../graph/tarjan.ts';
import { rangeToTableRef } from '../arrow/rangeTable.ts';
import { fnv1a32, mix32 } from '../util/hash.ts';
import {
  createCancellationSource,
  type CancellationSource, type CancellationToken, type Clock, type EngineOutcome, type PyBinding, type PyEngine,
  type PyInputValue, type RangeSnapshot, type SqlEngine, type SqlTableBinding,
} from '../ports/engines.ts';

export type TieBreak = { readonly kind: 'rowMajor' } | { readonly kind: 'seeded'; readonly seed: number };

export interface RecalcOptions {
  readonly tieBreak: TieBreak;
  readonly token: CancellationToken;
  /** Max synchronous evaluation time before awaiting deps.yieldControl(); 0 = never yield. */
  readonly sliceMs: number;
}

export interface CycleReport {
  readonly members: ReadonlyArray<CellKey>;
  readonly paths: ReadonlyMap<CellKey, ReadonlyArray<CellKey>>;
}

export interface RecalcResult {
  readonly generation: number;
  readonly values: ReadonlyMap<CellKey, CellValue>;
  readonly cycles: ReadonlyArray<CycleReport>;
  readonly pending: ReadonlyArray<CellKey>;
}

export type EngineEvent =
  | { readonly kind: 'cellCommitted'; readonly generation: number; readonly key: CellKey; readonly value: CellValue }
  | { readonly kind: 'cellPending'; readonly generation: number; readonly key: CellKey }
  | { readonly kind: 'generationComplete'; readonly generation: number }
  | { readonly kind: 'kernelException'; readonly key: CellKey; readonly fn: string; readonly message: string };

export interface EngineDeps {
  readonly sql: SqlEngine;
  readonly py: PyEngine;
  readonly clock: Clock;
  readonly yieldControl: () => Promise<void>;
}

export type ScenarioOverrides = ReadonlyArray<{ readonly cell: CellKey; readonly value: ScalarValue }>;

export interface ScenarioBatch {
  readonly scenarios: ReadonlyArray<ScenarioOverrides>;
  readonly targets: ReadonlyArray<CellKey>;
  readonly tieBreak: TieBreak;
  readonly token: CancellationToken;
}

export interface ScenarioBatchResult {
  readonly values: ReadonlyArray<ReadonlyMap<CellKey, CellValue>>;
  readonly subgraph: ReadonlyArray<CellKey>;
  readonly engineCalls: number;
  readonly events: ReadonlyArray<EngineEvent>;
}

export interface WorkbookEngine {
  applyEdits(edits: ReadonlyArray<Edit>): number;
  recalculate(opts: RecalcOptions): Promise<RecalcResult>;
  recalculateAll(opts: RecalcOptions): Promise<RecalcResult>;
  getValue(key: CellKey): CellValue | 'pending';
  getParsed(key: CellKey): ParsedCell | null;
  precedents(key: CellKey): ReadonlyArray<CellKey>;
  dependents(key: CellKey): ReadonlyArray<CellKey>;
  graphVersion(): number;
  definition(): WorkbookDefinition;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  evaluateScenarioBatch(batch: ScenarioBatch): Promise<ScenarioBatchResult>;
}

export class ScenarioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioConfigError';
  }
}

const MAX_RANGE_AREA = 2_000_000;

interface CellState {
  readonly key: CellKey;
  readonly coord: CellCoord;
  raw: string;
  literal: ScalarValue | undefined;
  parsed: ParsedCell;
}

function sameRange(a: RangeCoord, b: RangeCoord | undefined): boolean {
  return b !== undefined && a.sheet === b.sheet && a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
}

export function formatCyclePath(path: ReadonlyArray<CellKey>): string {
  const coords = path.map((k) => parseCellKey(k));
  const sheets = new Set(coords.map((c) => c?.sheet.toUpperCase() ?? ''));
  if (sheets.size === 1) return path.map((k) => k.slice(k.lastIndexOf('!') + 1)).join(' -> ');
  return path.join(' -> ');
}

class Engine implements WorkbookEngine {
  private sheets: string[];
  private names = new Map<string, NamedParameter>();
  private datasets = new Map<string, DatasetMeta>();
  private readonly seed: number;
  private readonly cells = new Map<CellKey, CellState>();
  private readonly values = new Map<CellKey, CellValue>();
  private readonly pending = new Set<CellKey>();
  /** Precedents per cell, sorted row-major: cell references (even to empty cells) plus existing members of referenced ranges. */
  private readonly prec = new Map<CellKey, CellKey[]>();
  /** Exact reverse of `prec`: the edges topological ordering uses. */
  private readonly deps = new Map<CellKey, Set<CellKey>>();
  /** Range references per dependent cell, so cells created or deleted inside a range re-link their range dependents. */
  private readonly rangeRefs = new Map<CellKey, ReadonlyArray<RangeCoord>>();
  /** Sorted `dependentsOf` results; invalidated per key when its reverse edges change, wholesale when range references change. */
  private readonly depCache = new Map<CellKey, ReadonlyArray<CellKey>>();
  private sheetRank = new Map<string, number>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly inflight = new Map<CellKey, { source: CancellationSource; promise: Promise<EngineOutcome> }>();
  private dirtyCarry = new Set<CellKey>();
  /**
   * Dirty roots not yet expanded into the dirty set. `applyEdits` only pushes the edited keys; `recalculate` expands them
   * (their transitive dependents) inside its time slices, so an edit never walks the whole graph synchronously.
   */
  private frontier: CellKey[] = [];
  private generation = 0;
  private version = 0;

  constructor(def: WorkbookDefinition, private readonly env: EngineDeps) {
    this.sheets = def.sheets.map((s) => s.name);
    this.rankSheets();
    this.seed = def.seed >>> 0;
    for (const n of def.names) this.names.set(n.name.toUpperCase(), n);
    for (const d of def.datasets) this.datasets.set(d.name, d);
    for (const sheet of def.sheets) {
      for (const c of sheet.cells) this.putCell(c.key, c.raw, c.literal);
    }
    this.rebuildGraph();
    for (const k of this.cells.keys()) this.frontier.push(k);
  }

  // ---------- model ----------

  private ctx(): ParseContext {
    return { sheetNames: this.sheets, names: this.names };
  }

  private canonicalKey(key: CellKey): { key: CellKey; coord: CellCoord } | null {
    const c = parseCellKey(key);
    if (c === null) return null;
    const sheet = this.sheets.find((s) => s.toUpperCase() === c.sheet.toUpperCase());
    if (sheet === undefined) return null;
    const coord = { sheet, row: c.row, col: c.col };
    return { key: toCellKey(coord), coord };
  }

  private putCell(key: CellKey, raw: string, literal: ScalarValue | undefined): CellKey | null {
    const ck = this.canonicalKey(key);
    if (ck === null) return null;
    if (raw === '' && literal === undefined) {
      this.cells.delete(ck.key);
      this.values.delete(ck.key);
      return ck.key;
    }
    const parsed: ParsedCell = literal !== undefined
      ? { dialect: 'literal', value: typeof literal === 'number' ? normalizeNumber(literal, 'none', ck.key, 'formula') : literal }
      : parseCell(raw, ck.coord, this.ctx());
    this.cells.set(ck.key, { key: ck.key, coord: ck.coord, raw, literal, parsed });
    return ck.key;
  }

  private refsOf(parsed: ParsedCell): ReadonlyArray<ResolvedRef> {
    return 'refs' in parsed ? parsed.refs : [];
  }

  /** Existing cells inside `r`: walks the range when it is smaller than the sheet's population, else scans the cells. */
  private rangeMembers(r: RangeCoord): CellKey[] {
    const out: CellKey[] = [];
    const area = (r.bottom - r.top + 1) * (r.right - r.left + 1);
    if (area <= this.cells.size) {
      const sheet = this.sheets.find((s) => s.toUpperCase() === r.sheet.toUpperCase()) ?? r.sheet;
      for (let row = r.top; row <= r.bottom; row++) {
        for (let col = r.left; col <= r.right; col++) {
          const k = toCellKey({ sheet, row, col });
          if (this.cells.has(k)) out.push(k);
        }
      }
      return out;
    }
    for (const c of this.cells.values()) if (rangeContains(r, c.coord)) out.push(c.key);
    return out;
  }

  /** A cell's precedents and range references, computed from its parsed references and the current cells. */
  private linksOf(key: CellKey): { readonly prec: CellKey[]; readonly ranges: ReadonlyArray<RangeCoord> } | null {
    const c = this.cells.get(key);
    if (c === undefined) return null;
    const ps = new Set<CellKey>();
    const ranges: RangeCoord[] = [];
    for (const ref of this.refsOf(c.parsed)) {
      if (ref.kind === 'cell') ps.add(toCellKey(ref.coord));
      else if (ref.kind === 'range') {
        ranges.push(ref.range);
        for (const m of this.rangeMembers(ref.range)) ps.add(m);
      }
    }
    return { prec: this.sortKeys([...ps]), ranges };
  }

  private rebuildGraph(): void {
    this.prec.clear();
    this.deps.clear();
    this.rangeRefs.clear();
    this.depCache.clear();
    for (const c of this.cells.values()) {
      const links = this.linksOf(c.key);
      if (links === null) continue;
      this.prec.set(c.key, links.prec);
      if (links.ranges.length > 0) this.rangeRefs.set(c.key, links.ranges);
      for (const p of links.prec) {
        let s = this.deps.get(p);
        if (s === undefined) this.deps.set(p, (s = new Set()));
        s.add(c.key);
      }
    }
    this.version++;
  }

  /**
   * Incremental graph maintenance (Spec 01 §7.1): recomputes one cell's outgoing edges and patches the reverse edges.
   * Returns whether any edge changed; `graphVersion` moves only then.
   */
  private relink(key: CellKey): boolean {
    const old = this.prec.get(key) ?? [];
    const oldRanges = this.rangeRefs.get(key) ?? [];
    const links = this.linksOf(key);
    const next = links?.prec ?? [];
    const ranges = links?.ranges ?? [];
    const precSame = old.length === next.length && old.every((k, i) => k === next[i]);
    const rangesSame = oldRanges.length === ranges.length && oldRanges.every((r, i) => sameRange(r, ranges[i]));
    if (links !== null) this.prec.set(key, next);
    else this.prec.delete(key);
    if (precSame && rangesSame) return false;
    if (!precSame) {
      for (const p of old) {
        this.deps.get(p)?.delete(key);
        this.depCache.delete(p);
      }
      for (const p of next) {
        let s = this.deps.get(p);
        if (s === undefined) this.deps.set(p, (s = new Set()));
        s.add(key);
        this.depCache.delete(p);
      }
    }
    if (!rangesSame) {
      if (ranges.length > 0) this.rangeRefs.set(key, ranges);
      else this.rangeRefs.delete(key);
      this.depCache.clear();
    }
    this.version++;
    return true;
  }

  /** Cells whose range references contain `key` (they gain or lose it as a precedent when it is created or deleted). */
  private rangeDependentsOf(key: CellKey): CellKey[] {
    const coord = parseCellKey(key);
    if (coord === null) return [];
    const out: CellKey[] = [];
    for (const [d, ranges] of this.rangeRefs) if (ranges.some((r) => rangeContains(r, coord))) out.push(d);
    return out;
  }

  private rankSheets(): void {
    this.sheetRank = new Map();
    this.sheets.forEach((s, i) => {
      const up = s.toUpperCase();
      if (!this.sheetRank.has(up)) this.sheetRank.set(up, i);
    });
  }

  private coordOf(key: CellKey): CellCoord {
    return this.cells.get(key)?.coord ?? parseCellKey(key) ?? { sheet: '', row: 0, col: 0 };
  }

  /** `compareRowMajor` over keys, with the sheet order precomputed (identical order, no per-comparison sheet search). */
  private readonly cmpKeys = (a: CellKey, b: CellKey): number => {
    const ca = this.coordOf(a);
    const cb = this.coordOf(b);
    if (ca.sheet !== cb.sheet) {
      const sa = this.sheetRank.get(ca.sheet.toUpperCase()) ?? this.sheets.length;
      const sb = this.sheetRank.get(cb.sheet.toUpperCase()) ?? this.sheets.length;
      if (sa !== sb) return sa - sb;
    }
    if (ca.row !== cb.row) return ca.row - cb.row;
    return ca.col - cb.col;
  };

  private sortKeys(keys: CellKey[]): CellKey[] {
    return keys.sort(this.cmpKeys);
  }

  /**
   * Cells to mark dirty when `key` changes, sorted row-major: its reverse edges, plus range dependents whose range
   * contains `key` even when `key` holds no cell (a deleted range member still dirties the range's dependents).
   */
  private dependentsOf(key: CellKey): ReadonlyArray<CellKey> {
    const hit = this.depCache.get(key);
    if (hit !== undefined) return hit;
    const direct = new Set(this.deps.get(key) ?? []);
    if (!this.cells.has(key)) for (const d of this.rangeDependentsOf(key)) direct.add(d);
    const sorted = this.sortKeys([...direct]);
    this.depCache.set(key, sorted);
    return sorted;
  }

  /**
   * Successors for topological ordering: exactly the reverse of `prec` (for an existing cell, `dependentsOf` already is;
   * for a deleted cell, its range dependents no longer count it as a precedent, so they must not be released by it).
   */
  private orderSucc(key: CellKey): ReadonlyArray<CellKey> {
    if (this.cells.has(key)) return this.dependentsOf(key);
    return this.sortKeys([...(this.deps.get(key) ?? [])]);
  }

  applyEdits(edits: ReadonlyArray<Edit>): number {
    let structural = false;
    /** Edited cell → whether it held a cell before this batch (creation and deletion re-link range dependents). */
    const changed = new Map<CellKey, boolean>();
    const put = (key: CellKey, raw: string, literal: ScalarValue | undefined): void => {
      const ck = this.canonicalKey(key)?.key;
      const existed = ck !== undefined && this.cells.has(ck);
      const k = this.putCell(key, raw, literal);
      if (k !== null && !changed.has(k)) changed.set(k, existed);
    };
    for (const e of edits) {
      switch (e.kind) {
        case 'setCell':
          put(e.key, e.raw, undefined);
          break;
        case 'setLiteral':
          put(e.key, literalDisplay(e.value), e.value);
          break;
        case 'clearCell':
          put(e.key, '', undefined);
          break;
        case 'setName':
          this.names.set(e.param.name.toUpperCase(), e.param);
          structural = true;
          break;
        case 'removeName':
          this.names.delete(e.name.toUpperCase());
          structural = true;
          break;
        case 'addSheet':
          if (isValidSheetName(e.name) && !this.sheets.some((s) => s.toUpperCase() === e.name.toUpperCase())) this.sheets.push(e.name);
          this.rankSheets();
          structural = true;
          break;
        case 'removeSheet': {
          const up = e.name.toUpperCase();
          this.sheets = this.sheets.filter((s) => s.toUpperCase() !== up);
          this.rankSheets();
          for (const k of [...this.cells.keys()]) {
            const c = this.cells.get(k);
            if (c !== undefined && c.coord.sheet.toUpperCase() === up) {
              this.cells.delete(k);
              this.values.delete(k);
            }
          }
          structural = true;
          break;
        }
        case 'registerDataset':
          this.datasets.set(e.meta.name, e.meta);
          structural = true;
          break;
        case 'dropDataset':
          this.datasets.delete(e.name);
          structural = true;
          break;
      }
    }
    if (structural) {
      // Names, sheets, and datasets change how every formula resolves: re-parse and rebuild (rare, never on the typing path).
      for (const c of this.cells.values()) {
        if (c.literal === undefined) c.parsed = parseCell(c.raw, c.coord, this.ctx());
        this.frontier.push(c.key);
      }
      this.rebuildGraph();
    } else {
      for (const k of changed.keys()) this.relink(k);
      for (const [k, existed] of changed) {
        if (existed === this.cells.has(k)) continue;
        for (const d of this.rangeDependentsOf(k)) if (!changed.has(d)) this.relink(d);
      }
    }
    for (const k of changed.keys()) this.frontier.push(k);
    // In-flight engine requests of the new dirty set are cancelled as `recalculate` expands the frontier, before any
    // request of this generation is dispatched (Spec 01 Req 10.4).
    this.generation++;
    return this.generation;
  }

  private closure(start: ReadonlyArray<CellKey>): Set<CellKey> {
    const seen = new Set<CellKey>();
    const stack = [...start];
    while (stack.length > 0) {
      const k = stack.pop() as CellKey;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const d of this.dependentsOf(k)) if (!seen.has(d)) stack.push(d);
    }
    return seen;
  }

  // ---------- evaluation helpers ----------

  private orderCmp(tie: TieBreak): (a: CellKey, b: CellKey) => number {
    const rm = this.cmpKeys;
    if (tie.kind === 'rowMajor') return rm;
    const seed = tie.seed >>> 0;
    const hashes = new Map<CellKey, number>();
    const h = (k: CellKey): number => {
      let v = hashes.get(k);
      if (v === undefined) hashes.set(k, (v = mix32(seed, fnv1a32(k))));
      return v;
    };
    return (a, b) => {
      const ha = h(a);
      const hb = h(b);
      return ha !== hb ? ha - hb : rm(a, b);
    };
  }

  private refValue(ref: ResolvedRef, look: (k: CellKey) => CellValue, origin: CellKey): EvalArg {
    if (ref.kind === 'unresolved') return { kind: 'scalar', value: makeError(ref.code, `cannot resolve ${ref.text}`, origin, 'formula') };
    if (ref.kind === 'cell') return { kind: 'scalar', value: look(toCellKey(ref.coord)) };
    const r = ref.range;
    const rows = r.bottom - r.top + 1;
    const cols = r.right - r.left + 1;
    if (rows * cols > MAX_RANGE_AREA) {
      return { kind: 'scalar', value: makeError('#VALUE!', `range ${ref.text} is larger than ${MAX_RANGE_AREA} cells`, origin, 'formula') };
    }
    const values: CellValue[] = [];
    for (let row = r.top; row <= r.bottom; row++) {
      for (let col = r.left; col <= r.right; col++) values.push(look(toCellKey({ sheet: r.sheet, row, col })));
    }
    return { kind: 'range', rows, cols, values };
  }

  private evalSync(c: CellState, look: (k: CellKey) => CellValue, events: EngineEvent[]): CellValue {
    const p = c.parsed;
    if (p.dialect === 'literal') return p.value;
    if (p.dialect === 'formula') {
      if ('parseError' in p) return makeError('#VALUE!', `syntax error at offset ${p.parseError.offset}: ${p.parseError.message}`, c.key, 'formula');
      return evaluateFormula(p.ast, {
        at: c.coord,
        valueOf: (ref) => this.refValue(ref, look, c.key),
        onKernelException: (fn, message) => events.push({ kind: 'kernelException', key: c.key, fn, message }),
      });
    }
    throw new Error('evalSync called on an engine cell');
  }

  /** Resolves an engine cell's inputs. Returns the first upstream error, or the request material. */
  private resolveSql(c: CellState, look: (k: CellKey) => CellValue):
    | { readonly error: CellError }
    | { readonly sql: string; readonly params: ScalarValue[]; readonly tables: SqlTableBinding[] } {
    const p = c.parsed;
    if (p.dialect !== 'sql') throw new Error('not a SQL cell');
    if (p.template.error !== undefined) return { error: makeError('#SQL!', p.template.error, c.key, 'sql') };
    let sql = p.template.text;
    const params: ScalarValue[] = [];
    const tables: SqlTableBinding[] = [];
    for (const slot of p.template.slots) {
      const v = this.refValue(slot.ref, look, c.key);
      let replacement: string;
      if (v.kind === 'range') {
        const scalars: ScalarValue[] = [];
        for (const m of v.values) {
          if (isCellError(m)) return { error: m };
          if (m !== null && typeof m === 'object') return { error: makeError('#VALUE!', 'ranges bound into SQL must hold scalar values', c.key, 'sql') };
          scalars.push(m);
        }
        const range = slot.ref.kind === 'range' ? slot.ref.range : null;
        const id = `__suture_b${tables.length}`;
        tables.push({ identifier: id, table: rangeToTableRef(v.rows, v.cols, range?.left ?? 0, scalars) });
        replacement = id;
      } else {
        const x = v.value;
        if (isCellError(x)) return { error: x };
        if (x !== null && typeof x === 'object') {
          if (x.kind === 'matrix') return { error: makeError('#VALUE!', 'a matrix cannot be interpolated into SQL', c.key, 'sql') };
          const id = `__suture_b${tables.length}`;
          tables.push({ identifier: id, table: x });
          replacement = id;
        } else {
          params.push(x);
          replacement = `$${params.length}`;
        }
      }
      sql = sql.split(slot.placeholder).join(replacement);
    }
    return { sql, params, tables };
  }

  private resolvePy(c: CellState, look: (k: CellKey) => CellValue): { readonly error: CellError } | { readonly inputs: PyBinding[] } {
    const p = c.parsed;
    if (p.dialect !== 'py') throw new Error('not a Python cell');
    const inputs: PyBinding[] = [];
    for (const k of p.program.inputKeys) {
      const v = this.refValue(k.ref, look, c.key);
      if (v.kind === 'range') {
        const values: ScalarValue[] = [];
        for (const m of v.values) {
          if (isCellError(m)) return { error: m };
          if (m !== null && typeof m === 'object') return { error: makeError('#VALUE!', 'ranges bound into Python must hold scalar values', c.key, 'py') };
          values.push(m);
        }
        const snap: RangeSnapshot = { kind: 'range', rows: v.rows, cols: v.cols, values };
        inputs.push({ key: k.key, value: snap });
      } else {
        if (isCellError(v.value)) return { error: v.value };
        inputs.push({ key: k.key, value: v.value as PyInputValue });
      }
    }
    return { inputs };
  }

  private pySeed(key: CellKey): number {
    return mix32(this.seed, fnv1a32(key));
  }

  private dispatch(c: CellState, look: (k: CellKey) => CellValue, generation: number):
    | { readonly now: CellValue }
    | { readonly later: Promise<EngineOutcome> } {
    const existing = this.inflight.get(c.key);
    if (existing !== undefined) return { later: existing.promise }; // re-tagged in-flight request
    const source = createCancellationSource();
    let promise: Promise<EngineOutcome>;
    if (c.parsed.dialect === 'sql') {
      const r = this.resolveSql(c, look);
      if ('error' in r) return { now: r.error };
      promise = this.env.sql.evaluate({ cell: c.key, generation, sql: r.sql, params: r.params, tables: r.tables }, source.token);
    } else if (c.parsed.dialect === 'py') {
      const r = this.resolvePy(c, look);
      if ('error' in r) return { now: r.error };
      promise = this.env.py.evaluate(
        { cell: c.key, generation, code: c.parsed.program.code, vectorized: c.parsed.program.vectorized, seed: this.pySeed(c.key), inputs: r.inputs },
        source.token,
      );
    } else {
      throw new Error('dispatch called on a non-engine cell');
    }
    this.inflight.set(c.key, { source, promise });
    return { later: promise };
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  // ---------- recalculation ----------

  async recalculateAll(opts: RecalcOptions): Promise<RecalcResult> {
    for (const k of this.cells.keys()) this.frontier.push(k);
    this.generation++;
    return this.recalculate(opts);
  }

  /**
   * Spec 01 §7.3. With `sliceMs > 0`, the slice clock starts when the call starts and covers every phase: expanding the
   * dirty frontier, computing in-degrees, cycle detection, and evaluation. No phase walks the whole dirty set without
   * checking the slice, so the first task after an edit ends within one slice plus one cell (or one budget check of
   * 64 graph steps). Yielding never reorders evaluation: a cell's release finishes before the next cell is popped.
   */
  async recalculate(opts: RecalcOptions): Promise<RecalcResult> {
    const generation = this.generation;
    const clock = this.env.clock;
    const slicing = opts.sliceMs > 0;
    let sliceStart = clock.now();
    let ops = 0;
    const isCurrent = (): boolean => generation === this.generation && !opts.token.cancelled;
    /** True every 64 graph steps once the slice is spent (never when slicing is off, which keeps that path synchronous). */
    const due = (): boolean => slicing && (++ops & 63) === 0 && clock.now() - sliceStart >= opts.sliceMs;
    const pause = async (): Promise<boolean> => {
      await this.env.yieldControl();
      sliceStart = clock.now();
      return isCurrent();
    };

    const committed = new Map<CellKey, CellValue>();
    const events: EngineEvent[] = [];
    const cycles: CycleReport[] = [];
    const waiting = new Map<CellKey, Promise<{ key: CellKey; outcome: EngineOutcome; src: Promise<EngineOutcome> }>>();
    const commit = (k: CellKey, v: CellValue): void => {
      assertCanonical(v);
      this.values.set(k, v);
      this.pending.delete(k);
      this.dirtyCarry.delete(k);
      committed.set(k, v);
      this.emit({ kind: 'cellCommitted', generation, key: k, value: v });
    };
    const look = (k: CellKey): CellValue => this.values.get(k) ?? null;

    const run = async (): Promise<void> => {
      // 1. Dirty set (Req 10.1): the edited cells plus all transitive dependents. Each newly dirty cell's in-flight engine
      //    request is cancelled here, before this generation dispatches anything (Req 10.4). The frontier is expanded in
      //    place: a generation superseded mid-expansion leaves the rest of it to the generation that superseded it, which
      //    may already be running.
      const seen = new Set<CellKey>();
      while (this.frontier.length > 0) {
        const k = this.frontier.pop() as CellKey;
        if (seen.has(k)) continue;
        seen.add(k);
        const inf = this.inflight.get(k);
        if (inf !== undefined) {
          inf.source.cancel();
          this.inflight.delete(k);
        }
        this.dirtyCarry.add(k);
        for (const d of this.dependentsOf(k)) if (!seen.has(d)) this.frontier.push(d);
        if (due() && !(await pause())) return;
      }
      if (!isCurrent()) return;

      // 2. Cells still dirty from this or an unfinished earlier generation; deleted cells drop their values.
      const dirty = new Set<CellKey>();
      for (const k of [...this.dirtyCarry]) {
        const exists = this.cells.has(k);
        if (exists || this.values.has(k)) dirty.add(k);
        if (!exists) {
          this.values.delete(k);
          this.dirtyCarry.delete(k);
        }
        if (due() && !(await pause())) return;
      }

      // 3. In-degrees, then a peel (Kahn without evaluation). Whatever cannot be peeled is a cycle or downstream of one;
      //    when everything peels (the common case) there is no cycle and Tarjan is skipped.
      const indeg = new Map<CellKey, number>();
      const peel = new Map<CellKey, number>();
      for (const k of dirty) {
        let n = 0;
        for (const p of this.prec.get(k) ?? []) if (dirty.has(p)) n++; // self-edges count, so self-loops never peel
        indeg.set(k, n);
        peel.set(k, n);
        if (due() && !(await pause())) return;
      }
      const queue: CellKey[] = [];
      for (const [k, n] of peel) if (n === 0) queue.push(k);
      for (let qi = 0; qi < queue.length; qi++) {
        const k = queue[qi] as CellKey;
        for (const d of this.orderSucc(k)) {
          const n = peel.get(d);
          if (n === undefined || d === k) continue;
          peel.set(d, n - 1);
          if (n - 1 === 0) queue.push(d);
          if (due() && !(await pause())) return;
        }
        if (due() && !(await pause())) return;
      }

      // 4. Cycles (Req 9): Tarjan over the unpeeled remainder only. Every strongly connected component of the dirty graph
      //    lies inside it. Reports are ordered by their first member, row-major.
      const cyclic = new Set<CellKey>();
      if (queue.length < dirty.size) {
        const rest = new Set<CellKey>();
        for (const [k, n] of peel) if (n > 0) rest.add(k);
        const succ = (k: CellKey): CellKey[] => this.orderSucc(k).filter((d) => rest.has(d));
        const reports: CycleReport[] = [];
        for (const comp of stronglyConnected(this.sortKeys([...rest]), succ)) {
          const first = comp[0];
          const selfLoop = comp.length === 1 && first !== undefined && (this.prec.get(first) ?? []).includes(first);
          if (comp.length < 2 && !selfLoop) continue;
          const members = new Set(comp);
          const sortedMembers = this.sortKeys([...comp]);
          const paths = new Map<CellKey, ReadonlyArray<CellKey>>();
          for (const m of sortedMembers) {
            // "A1 -> B2" reads "A1 references B2": follow precedents inside the component.
            paths.set(m, shortestCycle(m, members, (x) => (this.prec.get(x) ?? []).filter((p) => members.has(p))));
            cyclic.add(m);
          }
          reports.push({ members: sortedMembers, paths });
        }
        reports.sort((a, b) => this.cmpKeys(a.members[0] as CellKey, b.members[0] as CellKey));
        for (const r of reports) {
          for (const m of r.members) commit(m, makeError('#CYCLE!', `cycle: ${formatCyclePath(r.paths.get(m) ?? [m, m])}`, m, 'formula'));
          cycles.push(r);
        }
        // Kahn's in-degrees exclude cycle members, which already hold #CYCLE! and propagate it downstream (Req 9.5).
        for (const k of dirty) {
          if (cyclic.has(k)) {
            indeg.delete(k);
            continue;
          }
          let n = 0;
          for (const p of this.prec.get(k) ?? []) if (dirty.has(p) && !cyclic.has(p) && p !== k) n++;
          indeg.set(k, n);
          if (due() && !(await pause())) return;
        }
      }

      // 5. Kahn (Req 10.2): ready cells in tie-break order. A release can span a yield; no cell is popped until it ends.
      const heap = new MinHeap<CellKey>(this.orderCmp(opts.tieBreak));
      for (const [k, n] of indeg) {
        if (n === 0) heap.push(k);
        if (due() && !(await pause())) return;
      }
      let rel: { readonly list: ReadonlyArray<CellKey>; i: number; readonly from: CellKey } | null = null;
      /** Continues the current release; false when the slice ran out first. */
      const releaseStep = (): boolean => {
        const r = rel;
        if (r === null) return true;
        while (r.i < r.list.length) {
          const d = r.list[r.i++] as CellKey;
          if (d === r.from || !dirty.has(d) || cyclic.has(d)) continue;
          const n = (indeg.get(d) ?? 0) - 1;
          indeg.set(d, n);
          if (n === 0) heap.push(d);
          if (due()) return false;
        }
        rel = null;
        return true;
      };
      const release = (k: CellKey): boolean => {
        rel = { list: this.orderSucc(k), i: 0, from: k };
        return releaseStep();
      };

      while (heap.size > 0 || waiting.size > 0 || rel !== null) {
        if (!isCurrent()) return;
        if (rel !== null) {
          if (!releaseStep() && !(await pause())) return;
          continue;
        }
        const k = heap.pop();
        if (k !== undefined) {
          if (slicing && clock.now() - sliceStart >= opts.sliceMs && !(await pause())) return;
          if (!this.cells.has(k)) {
            this.values.delete(k);
            this.dirtyCarry.delete(k);
            if (!release(k) && !(await pause())) return;
            continue;
          }
          const c = this.cells.get(k) as CellState;
          if (c.parsed.dialect === 'sql' || c.parsed.dialect === 'py') {
            const d = this.dispatch(c, look, generation);
            if ('now' in d) {
              commit(k, d.now);
              if (!release(k) && !(await pause())) return;
            } else {
              this.pending.add(k);
              this.emit({ kind: 'cellPending', generation, key: k });
              const src = d.later;
              waiting.set(k, src.then((outcome) => ({ key: k, outcome, src })));
            }
          } else {
            commit(k, this.evalSync(c, look, events));
            if (!release(k) && !(await pause())) return;
          }
          continue;
        }
        const done = await Promise.race(waiting.values());
        sliceStart = clock.now(); // the engine reply arrived in a new task
        waiting.delete(done.key);
        if (this.inflight.get(done.key)?.promise === done.src) this.inflight.delete(done.key);
        if (!isCurrent()) return;
        if (done.outcome.kind === 'cancelled') continue;
        commit(done.key, done.outcome.value);
        if (!release(done.key) && !(await pause())) return;
      }
    };

    await run();
    for (const e of events) this.emit(e);
    if (isCurrent() && waiting.size === 0) this.emit({ kind: 'generationComplete', generation });
    return { generation, values: committed, cycles, pending: this.sortKeys([...this.pending]) };
  }

  // ---------- queries ----------

  getValue(key: CellKey): CellValue | 'pending' {
    const ck = this.canonicalKey(key)?.key ?? key;
    if (this.pending.has(ck)) return 'pending';
    return this.values.get(ck) ?? null;
  }

  getParsed(key: CellKey): ParsedCell | null {
    const ck = this.canonicalKey(key)?.key ?? key;
    return this.cells.get(ck)?.parsed ?? null;
  }

  precedents(key: CellKey): ReadonlyArray<CellKey> {
    return this.prec.get(this.canonicalKey(key)?.key ?? key) ?? [];
  }

  dependents(key: CellKey): ReadonlyArray<CellKey> {
    return this.dependentsOf(this.canonicalKey(key)?.key ?? key);
  }

  graphVersion(): number {
    return this.version;
  }

  definition(): WorkbookDefinition {
    return {
      sheets: this.sheets.map((name) => ({
        name,
        cells: this.sortKeys([...this.cells.values()].filter((c) => c.coord.sheet === name).map((c) => c.key)).map((k) => {
          const c = this.cells.get(k) as CellState;
          const src: CellSource = c.literal === undefined ? { key: c.key, raw: c.raw } : { key: c.key, raw: c.raw, literal: c.literal };
          return src;
        }),
      })),
      names: [...this.names.values()],
      datasets: [...this.datasets.values()],
      seed: this.seed,
    };
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- scenarios ----------

  async evaluateScenarioBatch(batch: ScenarioBatch): Promise<ScenarioBatchResult> {
    const overridden = new Set<CellKey>();
    for (const s of batch.scenarios) {
      for (const o of s) {
        const ck = this.canonicalKey(o.cell);
        if (ck === null) throw new ScenarioConfigError(`override target ${o.cell} is not a valid cell`);
        const c = this.cells.get(ck.key);
        if (c !== undefined && c.parsed.dialect !== 'literal') throw new ScenarioConfigError(`override target ${ck.key} is not a literal cell`);
        overridden.add(ck.key);
      }
    }
    const targets = batch.targets.map((t) => this.canonicalKey(t)?.key ?? t);
    const down = this.closure([...overridden]);
    const up = new Set<CellKey>();
    const stack = [...targets];
    while (stack.length > 0) {
      const k = stack.pop() as CellKey;
      if (up.has(k)) continue;
      up.add(k);
      for (const p of this.prec.get(k) ?? []) stack.push(p);
    }
    const sub = new Set<CellKey>([...down].filter((k) => up.has(k)));
    for (const k of overridden) sub.add(k);
    for (const k of targets) if (this.cells.has(k)) sub.add(k);

    // topological order within the subgraph (cycle members keep their committed #CYCLE!)
    const indeg = new Map<CellKey, number>();
    for (const k of sub) indeg.set(k, (this.prec.get(k) ?? []).filter((p) => sub.has(p) && p !== k).length);
    const heap = new MinHeap<CellKey>(this.orderCmp(batch.tieBreak));
    for (const [k, n] of indeg) if (n === 0) heap.push(k);
    const order: CellKey[] = [];
    for (let k = heap.pop(); k !== undefined; k = heap.pop()) {
      order.push(k);
      for (const d of this.orderSucc(k)) {
        if (!sub.has(d) || d === k) continue;
        const n = (indeg.get(d) ?? 0) - 1;
        indeg.set(d, n);
        if (n === 0) heap.push(d);
      }
    }
    const ordered = new Set(order);
    const inCycle = [...sub].filter((k) => !ordered.has(k));

    const n = batch.scenarios.length;
    const per: Array<Map<CellKey, CellValue>> = batch.scenarios.map((s) => {
      const m = new Map<CellKey, CellValue>();
      for (const k of inCycle) m.set(k, this.values.get(k) ?? null);
      for (const o of s) {
        const ck = this.canonicalKey(o.cell)?.key ?? o.cell;
        m.set(ck, typeof o.value === 'number' ? normalizeNumber(o.value, 'none', ck, 'formula') : o.value);
      }
      return m;
    });
    const lookFor = (i: number) => (k: CellKey): CellValue => {
      const m = per[i] as Map<CellKey, CellValue>;
      return m.has(k) ? (m.get(k) as CellValue) : this.values.get(k) ?? null;
    };
    const events: EngineEvent[] = [];
    let engineCalls = 0;

    for (const k of order) {
      if (batch.token.cancelled) break;
      const c = this.cells.get(k);
      if (c === undefined) {
        for (let i = 0; i < n; i++) if (!(per[i] as Map<CellKey, CellValue>).has(k)) (per[i] as Map<CellKey, CellValue>).set(k, null);
        continue;
      }
      if (overridden.has(k)) {
        for (let i = 0; i < n; i++) {
          const m = per[i] as Map<CellKey, CellValue>;
          if (!m.has(k)) m.set(k, this.values.get(k) ?? null);
        }
        continue;
      }
      if (c.parsed.dialect === 'literal' || c.parsed.dialect === 'formula') {
        for (let i = 0; i < n; i++) (per[i] as Map<CellKey, CellValue>).set(k, this.evalSync(c, lookFor(i), events));
        continue;
      }
      engineCalls += await this.batchEngineCell(c, n, lookFor, per, batch.token);
    }
    for (const m of per) for (const v of m.values()) assertCanonical(v);
    const subgraph = [...order, ...this.sortKeys(inCycle)];
    const values = per.map((m) => {
      const out = new Map<CellKey, CellValue>();
      for (const k of subgraph) out.set(k, m.get(k) ?? null);
      return out;
    });
    return { values, subgraph, engineCalls, events };
  }

  private async batchEngineCell(
    c: CellState, n: number, lookFor: (i: number) => (k: CellKey) => CellValue,
    per: Array<Map<CellKey, CellValue>>, token: CancellationToken,
  ): Promise<number> {
    const set = (i: number, v: CellValue): void => void (per[i] as Map<CellKey, CellValue>).set(c.key, v);
    const cancelled = (): void => {
      for (let i = 0; i < n; i++) set(i, makeError('#TIMEOUT!', 'scenario batch cancelled', c.key, c.parsed.dialect === 'sql' ? 'sql' : 'py'));
    };
    if (c.parsed.dialect === 'sql') {
      const groups = new Map<string, Array<{ i: number; params: ScalarValue[]; tables: SqlTableBinding[] }>>();
      for (let i = 0; i < n; i++) {
        const r = this.resolveSql(c, lookFor(i));
        if ('error' in r) set(i, r.error);
        else {
          let g = groups.get(r.sql);
          if (g === undefined) groups.set(r.sql, (g = []));
          g.push({ i, params: r.params, tables: r.tables });
        }
      }
      let calls = 0;
      for (const [sql, members] of groups) {
        const ids = (members[0]?.tables ?? []).map((t) => t.identifier);
        const shared: SqlTableBinding[] = [];
        const sharedIds = new Set<string>();
        for (const id of ids) {
          const first = members[0]?.tables.find((t) => t.identifier === id)?.table;
          if (first !== undefined && members.every((m) => m.tables.find((t) => t.identifier === id)?.table === first)) {
            shared.push({ identifier: id, table: first });
            sharedIds.add(id);
          }
        }
        calls++;
        const out = await this.env.sql.evaluateBatch(
          {
            cell: c.key, generation: this.generation, sql, shared,
            scenarios: members.map((m) => ({ params: m.params, tables: m.tables.filter((t) => !sharedIds.has(t.identifier)) })),
          },
          token,
        );
        if (out.kind === 'cancelled') cancelled();
        else members.forEach((m, j) => set(m.i, out.values[j] ?? makeError('#SQL!', 'missing batch result', c.key, 'sql')));
      }
      return calls;
    }
    if (c.parsed.dialect !== 'py') return 0;
    const program = c.parsed.program;
    const active: Array<{ i: number; inputs: PyBinding[] }> = [];
    for (let i = 0; i < n; i++) {
      const r = this.resolvePy(c, lookFor(i));
      if ('error' in r) set(i, r.error);
      else active.push({ i, inputs: r.inputs });
    }
    if (active.length === 0) return 0;
    const sharedKeys = new Set<string>();
    for (const b of active[0]?.inputs ?? []) {
      if (active.every((a) => {
        const v = a.inputs.find((x) => x.key === b.key)?.value;
        return v === b.value || (typeof v === 'number' && typeof b.value === 'number' && Object.is(v, b.value));
      })) sharedKeys.add(b.key);
    }
    const out = await this.env.py.evaluateBatch(
      {
        cell: c.key, generation: this.generation, code: program.code, vectorized: program.vectorized, seed: this.pySeed(c.key),
        shared: (active[0]?.inputs ?? []).filter((b) => sharedKeys.has(b.key)),
        scenarios: active.map((a) => a.inputs.filter((b) => !sharedKeys.has(b.key))),
      },
      token,
    );
    if (out.kind === 'cancelled') cancelled();
    else active.forEach((a, j) => set(a.i, out.values[j] ?? makeError('#PY!', 'missing batch result', c.key, 'py')));
    return 1;
  }
}

export function createWorkbookEngine(def: WorkbookDefinition, deps: EngineDeps): WorkbookEngine {
  return new Engine(def, deps);
}

export function sheetPrefix(sheet: string): string {
  return `${formatSheet(sheet)}!`;
}

export type { TableRef };
