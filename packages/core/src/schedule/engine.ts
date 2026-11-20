import {
  compareRowMajor, formatSheet, isValidSheetName, parseCellKey, rangeContains, toCellKey,
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
  private readonly prec = new Map<CellKey, CellKey[]>();
  private readonly deps = new Map<CellKey, Set<CellKey>>();
  private readonly rangeDeps: Array<{ readonly range: RangeCoord; readonly dependent: CellKey }> = [];
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly inflight = new Map<CellKey, { source: CancellationSource; promise: Promise<EngineOutcome> }>();
  private dirtyCarry = new Set<CellKey>();
  private edited = new Set<CellKey>();
  private generation = 0;
  private version = 0;

  constructor(def: WorkbookDefinition, private readonly env: EngineDeps) {
    this.sheets = def.sheets.map((s) => s.name);
    this.seed = def.seed >>> 0;
    for (const n of def.names) this.names.set(n.name.toUpperCase(), n);
    for (const d of def.datasets) this.datasets.set(d.name, d);
    for (const sheet of def.sheets) {
      for (const c of sheet.cells) this.putCell(c.key, c.raw, c.literal);
    }
    this.rebuildGraph();
    for (const k of this.cells.keys()) this.edited.add(k);
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

  private rangeMembers(r: RangeCoord): CellKey[] {
    const out: CellKey[] = [];
    for (const c of this.cells.values()) if (rangeContains(r, c.coord)) out.push(c.key);
    return out;
  }

  private rebuildGraph(): void {
    this.prec.clear();
    this.deps.clear();
    this.rangeDeps.length = 0;
    for (const c of this.cells.values()) {
      const ps = new Set<CellKey>();
      for (const ref of this.refsOf(c.parsed)) {
        if (ref.kind === 'cell') ps.add(toCellKey(ref.coord));
        else if (ref.kind === 'range') {
          this.rangeDeps.push({ range: ref.range, dependent: c.key });
          for (const m of this.rangeMembers(ref.range)) ps.add(m);
        }
      }
      const sorted = this.sortKeys([...ps]);
      this.prec.set(c.key, sorted);
      for (const p of sorted) {
        let s = this.deps.get(p);
        if (s === undefined) this.deps.set(p, (s = new Set()));
        s.add(c.key);
      }
    }
    this.version++;
  }

  private coordOf(key: CellKey): CellCoord {
    return this.cells.get(key)?.coord ?? parseCellKey(key) ?? { sheet: '', row: 0, col: 0 };
  }

  private sortKeys(keys: CellKey[]): CellKey[] {
    return keys.sort((a, b) => compareRowMajor(this.coordOf(a), this.coordOf(b), this.sheets));
  }

  private dependentsOf(key: CellKey): CellKey[] {
    const direct = new Set(this.deps.get(key) ?? []);
    const coord = parseCellKey(key);
    if (coord !== null) for (const rd of this.rangeDeps) if (rangeContains(rd.range, coord)) direct.add(rd.dependent);
    return this.sortKeys([...direct]);
  }

  applyEdits(edits: ReadonlyArray<Edit>): number {
    let structural = false;
    for (const e of edits) {
      switch (e.kind) {
        case 'setCell': {
          const k = this.putCell(e.key, e.raw, undefined);
          if (k !== null) this.edited.add(k);
          break;
        }
        case 'setLiteral': {
          const k = this.putCell(e.key, literalDisplay(e.value), e.value);
          if (k !== null) this.edited.add(k);
          break;
        }
        case 'clearCell': {
          const k = this.putCell(e.key, '', undefined);
          if (k !== null) this.edited.add(k);
          break;
        }
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
          structural = true;
          break;
        case 'removeSheet': {
          const up = e.name.toUpperCase();
          this.sheets = this.sheets.filter((s) => s.toUpperCase() !== up);
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
      for (const c of this.cells.values()) {
        if (c.literal === undefined) c.parsed = parseCell(c.raw, c.coord, this.ctx());
        this.edited.add(c.key);
      }
    }
    this.rebuildGraph();
    this.generation++;
    const fresh = this.closure([...this.edited]);
    for (const k of fresh) {
      const inf = this.inflight.get(k);
      if (inf !== undefined) {
        inf.source.cancel();
        this.inflight.delete(k);
      }
    }
    for (const k of fresh) this.dirtyCarry.add(k);
    this.edited.clear();
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
    const rm = (a: CellKey, b: CellKey): number => compareRowMajor(this.coordOf(a), this.coordOf(b), this.sheets);
    if (tie.kind === 'rowMajor') return rm;
    return (a, b) => {
      const ha = mix32(tie.seed >>> 0, fnv1a32(a));
      const hb = mix32(tie.seed >>> 0, fnv1a32(b));
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
    for (const k of this.cells.keys()) this.edited.add(k);
    this.applyEdits([]);
    return this.recalculate(opts);
  }

  async recalculate(opts: RecalcOptions): Promise<RecalcResult> {
    const generation = this.generation;
    const dirty = new Set([...this.dirtyCarry].filter((k) => this.cells.has(k) || this.values.has(k)));
    for (const k of [...this.dirtyCarry]) if (!this.cells.has(k)) {
      this.values.delete(k);
      this.dirtyCarry.delete(k);
    }
    const committed = new Map<CellKey, CellValue>();
    const events: EngineEvent[] = [];
    const isCurrent = (): boolean => generation === this.generation && !opts.token.cancelled;
    const commit = (k: CellKey, v: CellValue): void => {
      assertCanonical(v);
      this.values.set(k, v);
      this.pending.delete(k);
      this.dirtyCarry.delete(k);
      committed.set(k, v);
      this.emit({ kind: 'cellCommitted', generation, key: k, value: v });
    };
    const look = (k: CellKey): CellValue => this.values.get(k) ?? null;
    const succ = (k: CellKey): CellKey[] => this.dependentsOf(k).filter((d) => dirty.has(d));
    const nodes = this.sortKeys([...dirty]);

    // 1. cycles
    const cycles: CycleReport[] = [];
    const cyclic = new Set<CellKey>();
    for (const comp of stronglyConnected(nodes, succ)) {
      const first = comp[0];
      const selfLoop = comp.length === 1 && first !== undefined && (this.prec.get(first) ?? []).includes(first);
      if (comp.length < 2 && !selfLoop) continue;
      const members = new Set(comp);
      const sortedMembers = this.sortKeys([...comp]);
      const paths = new Map<CellKey, ReadonlyArray<CellKey>>();
      for (const m of sortedMembers) {
        // "A1 -> B2" reads "A1 references B2": follow precedents inside the component.
        const path = shortestCycle(m, members, (x) => (this.prec.get(x) ?? []).filter((p) => members.has(p)));
        paths.set(m, path);
        cyclic.add(m);
        commit(m, makeError('#CYCLE!', `cycle: ${formatCyclePath(path)}`, m, 'formula'));
      }
      cycles.push({ members: sortedMembers, paths });
    }

    // 2. Kahn over the acyclic remainder
    const indeg = new Map<CellKey, number>();
    for (const k of nodes) {
      if (cyclic.has(k)) continue;
      let n = 0;
      for (const p of this.prec.get(k) ?? []) if (dirty.has(p) && !cyclic.has(p) && p !== k) n++;
      indeg.set(k, n);
    }
    const heap = new MinHeap<CellKey>(this.orderCmp(opts.tieBreak));
    for (const [k, n] of indeg) if (n === 0) heap.push(k);
    const release = (k: CellKey): void => {
      for (const d of succ(k)) {
        if (cyclic.has(d)) continue;
        const n = (indeg.get(d) ?? 0) - 1;
        indeg.set(d, n);
        if (n === 0) heap.push(d);
      }
    };
    const waiting = new Map<CellKey, Promise<{ key: CellKey; outcome: EngineOutcome; src: Promise<EngineOutcome> }>>();
    let sliceStart = this.env.clock.now();
    const deleted = (k: CellKey): boolean => !this.cells.has(k);

    while (heap.size > 0 || waiting.size > 0) {
      if (!isCurrent()) break;
      const k = heap.pop();
      if (k !== undefined) {
        if (opts.sliceMs > 0 && this.env.clock.now() - sliceStart >= opts.sliceMs) {
          await this.env.yieldControl();
          sliceStart = this.env.clock.now();
          if (!isCurrent()) break;
        }
        if (deleted(k)) {
          this.values.delete(k);
          this.dirtyCarry.delete(k);
          release(k);
          continue;
        }
        const c = this.cells.get(k) as CellState;
        if (c.parsed.dialect === 'sql' || c.parsed.dialect === 'py') {
          const d = this.dispatch(c, look, generation);
          if ('now' in d) {
            commit(k, d.now);
            release(k);
          } else {
            this.pending.add(k);
            this.emit({ kind: 'cellPending', generation, key: k });
            const src = d.later;
            waiting.set(k, src.then((outcome) => ({ key: k, outcome, src })));
          }
        } else {
          commit(k, this.evalSync(c, look, events));
          release(k);
        }
        continue;
      }
      const done = await Promise.race(waiting.values());
      waiting.delete(done.key);
      if (this.inflight.get(done.key)?.promise === done.src) this.inflight.delete(done.key);
      if (!isCurrent()) break;
      if (done.outcome.kind === 'cancelled') continue;
      commit(done.key, done.outcome.value);
      release(done.key);
      sliceStart = this.env.clock.now();
    }
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
      for (const d of this.dependentsOf(k)) {
        if (!sub.has(d) || d === k) continue;
        const n = (indeg.get(d) ?? 0) - 1;
        indeg.set(d, n);
        if (n === 0) heap.push(d);
      }
    }
    const inCycle = [...sub].filter((k) => !order.includes(k));

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
