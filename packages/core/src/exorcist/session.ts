import * as fc from 'fast-check';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { CellKey } from '../model/address.ts';
import { toCellKey } from '../model/address.ts';
import { isCellError, type CellValue, type ScalarValue, type TableRef } from '../model/values.ts';
import { decodeTable, InvariantViolation } from '../boundary/normalize.ts';
import {
  createWorkbookEngine, ScenarioConfigError,
  type EngineDeps, type EngineEvent, type ScenarioOverrides, type WorkbookEngine,
} from '../schedule/engine.ts';
import { NEVER_CANCELLED, type CancellationToken } from '../ports/engines.ts';
import { fnv1a32, mix32 } from '../util/hash.ts';
import { decodeScalar, sortedInputs, workbookHash } from './artifact.ts';
import { checkRun, sameValue, type ProbeComparison, type RunValues } from './check.ts';
import type {
  CellAssertion, Compressor, ExecutionMode, ExorcistProgress, ExorcistVerdict, FuzzDomain, Hasher,
  LineageEdge, LineagePath, ReplayArtifact, SutureDocument, ViolatedAssertion,
} from './types.ts';

export interface ExorcistDeps {
  readonly engine: EngineDeps;
  readonly hasher: Hasher;
  readonly compressor: Compressor;
  readonly versions: { readonly suture: string; readonly fastCheck: string };
}

export type ReplayOutcome =
  | { readonly kind: 'reproduced'; readonly exact: boolean; readonly violation: ViolatedAssertion; readonly values: ReadonlyMap<CellKey, CellValue> }
  | { readonly kind: 'notReproduced'; readonly detail: string }
  | { readonly kind: 'hashMismatch'; readonly expected: string; readonly actual: string };

export interface ExorcistSession {
  readonly mode: ExecutionMode;
  run(opts: { readonly seed: number; readonly token: CancellationToken; readonly onProgress: (p: ExorcistProgress) => void }): Promise<ExorcistVerdict>;
  replay(artifact: ReplayArtifact, token: CancellationToken): Promise<ReplayOutcome>;
}

export interface RunSample {
  readonly base: ScenarioOverrides;
  readonly steps: ReadonlyArray<number>; // one per monotonic assertion, in document order
}

// ---------------------------------------------------------------- configuration

function domainOk(d: FuzzDomain): boolean {
  switch (d.kind) {
    case 'float': return Number.isFinite(d.min) && Number.isFinite(d.max) && d.min <= d.max;
    case 'integer': return Number.isSafeInteger(d.min) && Number.isSafeInteger(d.max) && d.min <= d.max;
    case 'choice': return d.values.length > 0;
    case 'boolean': return true;
  }
}

function assertionCells(a: CellAssertion): CellKey[] {
  const out = [a.cell];
  if (a.kind === 'gte' || a.kind === 'lte' || a.kind === 'gt' || a.kind === 'lt') { if (a.operand.kind === 'cell') out.push(a.operand.cell); }
  if (a.kind === 'between') {
    if (a.min.kind === 'cell') out.push(a.min.cell);
    if (a.max.kind === 'cell') out.push(a.max.cell);
  }
  return out;
}

export function validateConfig(doc: SutureDocument, engine: WorkbookEngine): { readonly ok: true; readonly mode: ExecutionMode; readonly subgraph: ReadonlyArray<CellKey> } | { readonly ok: false; readonly message: string } {
  const cfg = doc.exorcist;
  if (cfg.inputs.length === 0) return { ok: false, message: 'declare at least one fuzz input' };
  if (cfg.batchSize < 100 || cfg.batchSize > 200) return { ok: false, message: `batchSize ${cfg.batchSize} is outside 100–200` };
  for (const i of cfg.inputs) {
    if (!domainOk(i.domain)) return { ok: false, message: `fuzz input ${i.cell} has an invalid domain` };
    const p = engine.getParsed(i.cell);
    if (p !== null && p.dialect !== 'literal') return { ok: false, message: `fuzz input ${i.cell} is not a literal cell` };
  }
  for (const a of cfg.assertions) {
    for (const c of assertionCells(a)) if (engine.getParsed(c) === null) return { ok: false, message: `assertion ${a.id} references missing cell ${c}` };
    if (a.kind === 'monotonicWith') {
      const inp = cfg.inputs.find((i) => i.cell === a.input);
      if (inp === undefined || (inp.domain.kind !== 'float' && inp.domain.kind !== 'integer')) {
        return { ok: false, message: `assertion ${a.id}: ${a.input} must be a float or integer fuzz input` };
      }
    }
  }
  const targets = cfg.assertions.flatMap(assertionCells);
  const sub = subgraphOf(engine, cfg.inputs.map((i) => i.cell), targets);
  const batched = sub.some((k) => {
    const p = engine.getParsed(k);
    return p !== null && (p.dialect === 'sql' || p.dialect === 'py');
  });
  return { ok: true, mode: batched ? 'batched' : 'inProcess', subgraph: sub };
}

function subgraphOf(engine: WorkbookEngine, inputs: ReadonlyArray<CellKey>, targets: ReadonlyArray<CellKey>): CellKey[] {
  const down = new Set<CellKey>();
  const stack = [...inputs];
  while (stack.length > 0) {
    const k = stack.pop() as CellKey;
    if (down.has(k)) continue;
    down.add(k);
    for (const d of engine.dependents(k)) stack.push(d);
  }
  const up = new Set<CellKey>();
  const st2 = [...targets];
  while (st2.length > 0) {
    const k = st2.pop() as CellKey;
    if (up.has(k)) continue;
    up.add(k);
    for (const p of engine.precedents(k)) st2.push(p);
  }
  const out = [...down].filter((k) => up.has(k));
  for (const k of [...inputs, ...targets]) if (!out.includes(k)) out.push(k);
  return out;
}

// ---------------------------------------------------------------- arbitraries

function domainArb(d: FuzzDomain): fc.Arbitrary<ScalarValue> {
  switch (d.kind) {
    case 'float': return fc.double({ min: d.min, max: d.max, noNaN: true, noDefaultInfinity: true });
    case 'integer': return fc.integer({ min: d.min, max: d.max });
    case 'choice': return fc.constantFrom(...d.values);
    case 'boolean': return fc.boolean();
  }
}

export function runArbitrary(doc: SutureDocument): fc.Arbitrary<RunSample> {
  const cfg = doc.exorcist;
  const inputs = fc.tuple(...cfg.inputs.map((i) => domainArb(i.domain)));
  const monos = cfg.assertions.filter((a) => a.kind === 'monotonicWith');
  const steps = fc.tuple(...monos.map((a) => {
    const d = cfg.inputs.find((i) => i.cell === (a.kind === 'monotonicWith' ? a.input : ''))?.domain;
    if (d?.kind === 'integer') return fc.integer({ min: 1, max: Math.max(1, d.max - d.min) });
    const span = d?.kind === 'float' ? d.max - d.min : 1;
    return fc.double({ min: 0, max: span, noNaN: true, noDefaultInfinity: true, minExcluded: true });
  }));
  return fc.tuple(inputs, steps).map(([vals, st]) => ({
    base: cfg.inputs.map((inp, i) => ({ cell: inp.cell, value: vals[i] ?? null })),
    steps: st,
  }));
}

/** base scenario + one paired scenario per monotonic assertion (dropped when clamping leaves the input unchanged). */
function expand(doc: SutureDocument, s: RunSample): { scenarios: ScenarioOverrides[]; pairIds: string[] } {
  const scenarios: ScenarioOverrides[] = [s.base];
  const pairIds: string[] = [];
  const monos = doc.exorcist.assertions.filter((a) => a.kind === 'monotonicWith');
  monos.forEach((a, j) => {
    if (a.kind !== 'monotonicWith') return;
    const d = doc.exorcist.inputs.find((i) => i.cell === a.input)?.domain;
    const cur = s.base.find((o) => o.cell === a.input)?.value;
    if (d === undefined || typeof cur !== 'number' || (d.kind !== 'float' && d.kind !== 'integer')) return;
    const next = Math.min(cur + (s.steps[j] ?? 0), d.max);
    if (next === cur) return;
    scenarios.push(s.base.map((o) => (o.cell === a.input ? { cell: o.cell, value: next } : o)));
    pairIds.push(a.id);
  });
  return { scenarios, pairIds };
}

function sameViolation(a: ViolatedAssertion, b: ViolatedAssertion): boolean {
  if (a.tier !== b.tier) return false;
  if (a.tier === 1 && b.tier === 1) return a.invariant === b.invariant;
  if (a.tier === 2 && b.tier === 2) return a.assertion.id === b.assertion.id;
  return false;
}

// ---------------------------------------------------------------- session

export async function createExorcistSession(doc: SutureDocument, deps: ExorcistDeps): Promise<ExorcistSession | { readonly configError: string }> {
  const engine = createWorkbookEngine(doc.workbook, deps.engine);
  await engine.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
  const v = validateConfig(doc, engine);
  if (!v.ok) return { configError: v.message };
  return new Session(doc, deps, engine, v.mode, v.subgraph);
}

interface Evaluated {
  readonly runs: ReadonlyArray<RunValues>;
  readonly events: ReadonlyArray<EngineEvent>;
  readonly probes: ReadonlyArray<ReadonlyArray<ProbeComparison>>;
  readonly subgraph: ReadonlyArray<CellKey>;
}

class Session implements ExorcistSession {
  private readonly targets: CellKey[];
  private readonly arb: fc.Arbitrary<RunSample>;

  constructor(
    private readonly doc: SutureDocument,
    private readonly deps: ExorcistDeps,
    private readonly engine: WorkbookEngine,
    readonly mode: ExecutionMode,
    private readonly subgraph: ReadonlyArray<CellKey>,
  ) {
    this.targets = doc.exorcist.assertions.flatMap(assertionCells);
    this.arb = runArbitrary(doc);
  }

  private base(k: CellKey): CellValue {
    const v = this.engine.getValue(k);
    return v === 'pending' ? null : v;
  }

  /** Evaluates many runs in one scenario batch (≤ 1 engine call per engine cell) plus ≤ 2 probe calls. */
  private async evaluate(samples: ReadonlyArray<RunSample>, token: CancellationToken, withProbes: boolean): Promise<Evaluated> {
    const flat: ScenarioOverrides[] = [];
    const shape: Array<{ start: number; pairIds: string[] }> = [];
    for (const s of samples) {
      const e = expand(this.doc, s);
      shape.push({ start: flat.length, pairIds: e.pairIds });
      flat.push(...e.scenarios);
    }
    const res = await this.engine.evaluateScenarioBatch({ scenarios: flat, targets: this.targets, tieBreak: { kind: 'rowMajor' }, token });
    const runs: RunValues[] = shape.map((sh) => ({
      base: res.values[sh.start] ?? new Map(),
      pairs: sh.pairIds.map((id, j) => ({ assertionId: id, values: res.values[sh.start + 1 + j] ?? new Map() })),
    }));
    const probes = withProbes && this.mode === 'batched' ? await this.probe(runs, token) : runs.map(() => []);
    return { runs, events: res.events, probes, subgraph: res.subgraph };
  }

  /** Cross-engine probes: numeric columns of TableRefs bound into PY cells, aggregated in DuckDB and NumPy. */
  private async probe(runs: ReadonlyArray<RunValues>, token: CancellationToken): Promise<ProbeComparison[][]> {
    const out: ProbeComparison[][] = runs.map(() => []);
    const targets: Array<{ run: number; cell: CellKey; key: string; table: TableRef; columns: string[] }> = [];
    for (const k of this.subgraph) {
      const p = this.engine.getParsed(k);
      if (p === null || p.dialect !== 'py') continue;
      for (const inp of p.program.inputKeys) {
        if (inp.ref.kind !== 'cell') continue;
        const src = toCellKey(inp.ref.coord);
        runs.forEach((r, i) => {
          const v = r.base.has(src) ? r.base.get(src) : this.base(src);
          if (v === null || v === undefined || typeof v !== 'object' || v.kind !== 'table') return;
          const columns = v.schema.filter((f) => /^(Float|Int|Uint)/.test(f.arrowType)).map((f) => f.name);
          if (columns.length > 0) targets.push({ run: i, cell: k, key: inp.key, table: v, columns });
        });
      }
    }
    if (targets.length === 0) return out;
    const distinct: typeof targets = [];
    for (const t of targets) if (!distinct.some((d) => d.table === t.table)) distinct.push(t);
    const cols = distinct[0]?.columns ?? [];
    const quoted = (c: string): string => `"${c.replaceAll('"', '""')}"`;
    const sql = `SELECT ${cols.map((c) => `sum(${quoted(c)})::DOUBLE, avg(${quoted(c)})::DOUBLE, min(${quoted(c)})::DOUBLE, max(${quoted(c)})::DOUBLE, count(${quoted(c)})::DOUBLE`).join(', ')} FROM __suture_b0`;
    const pyCode = [
      't = inputs["t"]',
      `cols = ${JSON.stringify(cols)}`,
      'np.array([[float(np.ma.sum(t[c])), float(np.ma.mean(t[c])), float(np.ma.min(t[c])), float(np.ma.max(t[c])), float(np.ma.count(t[c]))] for c in cols])',
    ].join('\n');
    const cell = distinct[0]?.cell as CellKey;
    const [s, p] = await Promise.all([
      this.deps.engine.sql.evaluateBatch({ cell, generation: 0, sql, shared: [], scenarios: distinct.map((d) => ({ params: [], tables: [{ identifier: '__suture_b0', table: d.table }] })) }, token),
      this.deps.engine.py.evaluateBatch({ cell, generation: 0, code: pyCode, vectorized: false, seed: 0, shared: [], scenarios: distinct.map((d) => [{ key: 't', value: d.table }]) }, token),
    ]);
    if (s.kind === 'cancelled' || p.kind === 'cancelled') return out;
    const aggs = ['sum', 'mean', 'min', 'max', 'count'] as const;
    distinct.forEach((d, j) => {
      const sv = s.values[j];
      const pv = p.values[j];
      if (sv === undefined || pv === undefined || sv === null || pv === null || typeof sv !== 'object' || typeof pv !== 'object') return;
      if (sv.kind !== 'table' || pv.kind !== 'matrix') return;
      const row = decodeTable(sv).get(0)?.toArray() as unknown[] | undefined;
      if (row === undefined) return;
      d.columns.forEach((col, ci) => {
        const count = Number(row[ci * 5 + 4]);
        if (count === 0) return;
        aggs.forEach((agg, ai) => {
          const a = Number(row[ci * 5 + ai]);
          const b = pv.data[ci * 5 + ai] ?? Number.NaN;
          for (const t of targets.filter((x) => x.table === d.table)) {
            (out[t.run] as ProbeComparison[]).push({ source: { cell: t.cell, binding: t.key, column: col }, aggregate: agg, values: [{ engine: 'sql', value: a }, { engine: 'py', value: b }] });
          }
        });
      });
    });
    return out;
  }

  private check(ev: Evaluated, i: number): ViolatedAssertion | null {
    const run = ev.runs[i];
    if (run === undefined) return null;
    return checkRun({
      engine: this.engine, subgraph: ev.subgraph, run, fallback: (k) => this.base(k),
      assertions: this.doc.exorcist.assertions, engineEvents: ev.events, probes: ev.probes[i] ?? [],
    });
  }

  /** Tier 1 determinism: seeded topological order and a fresh engine fed setLiteral edits in a permuted order. */
  /** Seeded-topological-order re-evaluation of several runs in ONE scenario batch; returns the first differing run. */
  private async seededCheck(samples: ReadonlyArray<RunSample>, values: ReadonlyArray<ReadonlyMap<CellKey, CellValue>>, seed: number, token: CancellationToken): Promise<{ index: number; violation: ViolatedAssertion } | null> {
    if (samples.length === 0) return null;
    const seeded = await this.engine.evaluateScenarioBatch({ scenarios: samples.map((s) => s.base), targets: this.targets, tieBreak: { kind: 'seeded', seed }, token });
    for (let i = 0; i < samples.length; i++) {
      const sv = seeded.values[i] ?? new Map<CellKey, CellValue>();
      for (const [k, v] of values[i] ?? new Map<CellKey, CellValue>()) {
        if (!sameValue(v, sv.get(k) ?? null)) {
          return { index: i, violation: { tier: 1, invariant: 'T1.editOrderDeterminism', cell: k, detail: `${k} differs under a seeded topological order (seed ${seed})` } };
        }
      }
    }
    return null;
  }

  private async determinism(sample: RunSample, values: ReadonlyMap<CellKey, CellValue>, seed: number, runIndex: number, fresh: boolean, token: CancellationToken): Promise<ViolatedAssertion | null> {
    const s = await this.seededCheck([sample], [values], mix32(seed, runIndex), token);
    if (s !== null) return s.violation;
    if (!fresh) return null;
    return this.freshCheck(sample, values, seed, runIndex, token);
  }

  private async freshCheck(sample: RunSample, values: ReadonlyMap<CellKey, CellValue>, seed: number, runIndex: number, token: CancellationToken): Promise<ViolatedAssertion | null> {
    const e2 = createWorkbookEngine(this.engine.definition(), this.deps.engine);
    const order = mix32(seed, runIndex);
    const perm = [...sample.base].sort((a, b) => mix32(order, fnv1a32(a.cell)) - mix32(order, fnv1a32(b.cell)));
    e2.applyEdits(perm.map((o) => ({ kind: 'setLiteral' as const, key: o.cell, value: o.value })));
    await e2.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token, sliceMs: 0 });
    for (const [k, v] of values) {
      const w = e2.getValue(k);
      if (w === 'pending' || !sameValue(v, w)) {
        return { tier: 1, invariant: 'T1.editOrderDeterminism', cell: k, detail: `${k} differs between scenario evaluation and setLiteral edits + full recalculation (run ${runIndex})` };
      }
    }
    return null;
  }

  private async evaluateOne(sample: RunSample, token: CancellationToken, seed: number, runIndex: number, full: boolean): Promise<{ violation: ViolatedAssertion | null; values: ReadonlyMap<CellKey, CellValue> }> {
    let ev: Evaluated;
    try {
      ev = await this.evaluate([sample], token, true);
    } catch (e) {
      if (e instanceof InvariantViolation) return { violation: { tier: 1, invariant: 'T1.noNonFiniteLeak', cell: null, detail: e.message }, values: new Map() };
      if (e instanceof ScenarioConfigError) throw e;
      return { violation: { tier: 1, invariant: 'T1.noUnhandledException', cell: null, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, values: new Map() };
    }
    const values = ev.runs[0]?.base ?? new Map<CellKey, CellValue>();
    const v = this.check(ev, 0);
    if (v !== null) return { violation: v, values };
    if (full || runIndex % 10 === 0) {
      const d = await this.determinism(sample, values, seed, runIndex, full || runIndex % 50 === 0, token);
      if (d !== null) return { violation: d, values };
    }
    return { violation: null, values };
  }

  // ------------------------------------------------------------ simplification + lineage + artifact

  private simplifyCandidates(sample: RunSample): Array<{ input: number; digits: number; sample: RunSample }> {
    const out: Array<{ input: number; digits: number; sample: RunSample }> = [];
    this.doc.exorcist.inputs.forEach((inp, i) => {
      const cur = sample.base[i]?.value;
      if (inp.domain.kind !== 'float' || typeof cur !== 'number') return;
      for (let d = 1; d <= 6; d++) {
        const r = Number(cur.toPrecision(d));
        if (Object.is(r, cur) || r < inp.domain.min || r > inp.domain.max) continue;
        out.push({ input: i, digits: d, sample: { base: sample.base.map((o, j) => (j === i ? { cell: o.cell, value: r } : o)), steps: sample.steps } });
      }
    });
    return out;
  }

  private applyDigits(sample: RunSample, digits: ReadonlyArray<number>): RunSample {
    return {
      base: sample.base.map((o, i) => {
        const d = digits[i] ?? 0;
        return d > 0 && typeof o.value === 'number' ? { cell: o.cell, value: Number(o.value.toPrecision(d)) } : o;
      }),
      steps: sample.steps,
    };
  }

  /** Greedy per-input decimal simplification; returns the chosen digits per input (0 = unchanged). */
  private async simplify(sample: RunSample, target: ViolatedAssertion, token: CancellationToken): Promise<{ sample: RunSample; digits: number[] }> {
    const digits = this.doc.exorcist.inputs.map(() => 0);
    let cur = sample;
    for (let i = 0; i < this.doc.exorcist.inputs.length; i++) {
      const cands = this.simplifyCandidates(cur).filter((c) => c.input === i);
      if (cands.length === 0) continue;
      const ev = await this.evaluate(cands.map((c) => c.sample), token, false);
      for (let j = 0; j < cands.length; j++) {
        const v = this.check(ev, j);
        const c = cands[j];
        if (v !== null && c !== undefined && sameViolation(v, target)) {
          cur = c.sample;
          digits[i] = c.digits;
          break;
        }
      }
    }
    return { sample: cur, digits };
  }

  private lineage(sample: RunSample, values: ReadonlyMap<CellKey, CellValue>, violation: ViolatedAssertion): LineagePath {
    const violating = violation.tier === 2 ? violation.assertion.cell : violation.cell ?? this.targets[0] ?? null;
    const changed = sample.base.filter((o) => !Object.is(o.value, this.base(o.cell))).map((o) => o.cell);
    const starts = changed.length > 0 ? changed : this.doc.exorcist.inputs.map((i) => i.cell);
    if (violating === null) return { cells: [], edges: [], failingEdge: null };
    const sub = new Set(subgraphOf(this.engine, starts, [violating]));
    // Deterministic topological order: DFS post-order over precedents, roots taken in sorted key order.
    const order: CellKey[] = [];
    const seen = new Set<CellKey>();
    const visit = (k: CellKey): void => {
      if (seen.has(k)) return;
      seen.add(k);
      for (const p of this.engine.precedents(k)) if (sub.has(p) && p !== k) visit(p);
      order.push(k);
    };
    for (const k of [...sub].sort()) visit(k);
    const edges: LineageEdge[] = [];
    for (const to of order) for (const from of this.engine.precedents(to)) if (sub.has(from) && from !== to) edges.push({ from, to });
    let failingEdge: LineageEdge | null = null;
    for (const k of order) {
      const v = values.get(k) ?? this.base(k);
      if (isCellError(v) || k === violating) {
        const from = edges.find((e) => e.to === k)?.from;
        if (from !== undefined) failingEdge = { from, to: k };
        break;
      }
    }
    return { cells: order, edges, failingEdge };
  }

  private async artifact(mode: ExecutionMode, seed: number, path: string, sample: RunSample, violation: ViolatedAssertion, values: ReadonlyMap<CellKey, CellValue>): Promise<ReplayArtifact> {
    return {
      format: 'suture.replay', version: 1, mode, seed, path,
      numRuns: mode === 'inProcess' ? this.doc.exorcist.numRuns : this.doc.exorcist.batchSize * this.doc.exorcist.maxBatches,
      batchSize: mode === 'inProcess' ? 1 : this.doc.exorcist.batchSize,
      failingInputs: sortedInputs(sample.base),
      violatedAssertion: violation,
      lineagePath: this.lineage(sample, values, violation),
      workbookHash: await workbookHash(this.doc, this.deps.hasher),
      sutureVersion: this.deps.versions.suture,
      fastCheckVersion: this.deps.versions.fastCheck,
      createdAt: new Date(this.deps.engine.clock.now()).toISOString(),
    };
  }

  // ------------------------------------------------------------ run

  async run(opts: { readonly seed: number; readonly token: CancellationToken; readonly onProgress: (p: ExorcistProgress) => void }): Promise<ExorcistVerdict> {
    const started = this.deps.engine.clock.now();
    let lastProgress = -Infinity;
    const progress = (p: ExorcistProgress, force = false): void => {
      const now = this.deps.engine.clock.now();
      if (force || now - lastProgress >= 200) {
        lastProgress = now;
        opts.onProgress(p);
      }
    };
    try {
      return this.mode === 'inProcess' ? await this.runInProcess(opts.seed, opts.token, progress, started) : await this.runBatched(opts.seed, opts.token, progress, started);
    } catch (e) {
      if (e instanceof ScenarioConfigError) return { kind: 'configError', message: e.message };
      throw e;
    }
  }

  private async runInProcess(seed: number, token: CancellationToken, progress: (p: ExorcistProgress, force?: boolean) => void, started: number): Promise<ExorcistVerdict> {
    let runIndex = 0;
    let shrinkSteps = 0;
    let found = false;
    const property = fc.asyncProperty(this.arb, async (sample) => {
      const idx = runIndex++;
      if (found) shrinkSteps++;
      const r = await this.evaluateOne(sample, token, seed, idx, false);
      progress({ phase: found ? 'shrink' : 'search', mode: 'inProcess', runs: idx + 1, scenarios: idx + 1, shrinkRounds: shrinkSteps });
      if (r.violation !== null) found = true;
      return r.violation === null;
    });
    const details = await fc.check(property, { seed, numRuns: this.doc.exorcist.numRuns, endOnFailure: false, interruptAfterTimeLimit: 120_000 });
    if (token.cancelled) return { kind: 'stopped' };
    if (!details.failed || details.counterexample === null) {
      return { kind: 'passed', runs: details.numRuns, scenarios: details.numRuns, durationMs: this.deps.engine.clock.now() - started };
    }
    const [shrunk] = details.counterexample;
    return this.finish('inProcess', seed, details.counterexamplePath ?? '', shrunk, token, progress);
  }

  private async finish(mode: ExecutionMode, seed: number, path: string, shrunk: RunSample, token: CancellationToken, progress: (p: ExorcistProgress, force?: boolean) => void): Promise<ExorcistVerdict> {
    progress({ phase: 'confirm', mode, runs: 0, scenarios: 0, shrinkRounds: 0 }, true);
    const first = await this.evaluateOne(shrunk, token, seed, 0, true);
    if (first.violation === null) {
      const v: ViolatedAssertion = { tier: 1, invariant: 'T1.editOrderDeterminism', cell: null, detail: 'the shrunk counterexample does not reproduce when evaluated alone (batch/single mismatch)' };
      return { kind: 'violated', artifact: await this.artifact(mode, seed, `${path}|`, shrunk, v, first.values) };
    }
    const simp = await this.simplify(shrunk, first.violation, token);
    const confirmed = await this.evaluateOne(simp.sample, token, seed, 0, true);
    const violation = confirmed.violation ?? first.violation;
    const sample = confirmed.violation !== null ? simp.sample : shrunk;
    const digits = confirmed.violation !== null ? simp.digits : simp.digits.map(() => 0);
    return { kind: 'violated', artifact: await this.artifact(mode, seed, `${path}|${digits.join(',')}`, sample, violation, confirmed.values) };
  }

  private async runBatched(seed: number, token: CancellationToken, progress: (p: ExorcistProgress, force?: boolean) => void, started: number): Promise<ExorcistVerdict> {
    const cfg = this.doc.exorcist;
    const mrng = new fc.Random(xoroshiro128plus(seed));
    let scenarios = 0;
    for (let b = 0; b < cfg.maxBatches; b++) {
      if (token.cancelled) return { kind: 'stopped' };
      const chunk: Array<fc.Value<RunSample>> = [];
      for (let k = 0; k < cfg.batchSize; k++) {
        const i = b * cfg.batchSize + k;
        chunk.push(this.arb.generate(mrng, 2 + Math.floor(Math.log10(i + 1))));
      }
      const ev = await this.evaluate(chunk.map((c) => c.value), token, true);
      scenarios += ev.runs.reduce((n, r) => n + 1 + r.pairs.length, 0);
      let failing = -1;
      for (let k = 0; k < chunk.length; k++) {
        if (this.check(ev, k) !== null) {
          failing = k;
          break;
        }
      }
      if (failing < 0) {
        // Tier 1 determinism: every 10th run under a seeded order (one extra batch), every 50th on a fresh engine.
        const tenth = chunk.map((_c, k) => k).filter((k) => (b * cfg.batchSize + k) % 10 === 0);
        const s = await this.seededCheck(tenth.map((k) => (chunk[k] as fc.Value<RunSample>).value), tenth.map((k) => ev.runs[k]?.base ?? new Map()), mix32(seed, b), token);
        if (s !== null) failing = tenth[s.index] ?? -1;
        for (const k of tenth) {
          const i = b * cfg.batchSize + k;
          if (failing >= 0 || i % 50 !== 0) continue;
          const d = await this.freshCheck((chunk[k] as fc.Value<RunSample>).value, ev.runs[k]?.base ?? new Map(), seed, i, token);
          if (d !== null) failing = k;
        }
      }
      progress({ phase: 'search', mode: 'batched', runs: (b + 1) * cfg.batchSize, scenarios, shrinkRounds: 0 }, true);
      if (failing >= 0) {
        const startIndex = b * cfg.batchSize + failing;
        const start = chunk[failing] as fc.Value<RunSample>;
        const shrunk = await this.shrinkBatched(start, token, (rounds) => progress({ phase: 'shrink', mode: 'batched', runs: (b + 1) * cfg.batchSize, scenarios, shrinkRounds: rounds }));
        return this.finish('batched', seed, [startIndex, ...shrunk.path].join(':'), shrunk.value, token, progress);
      }
    }
    return { kind: 'passed', runs: cfg.batchSize * cfg.maxBatches, scenarios, durationMs: this.deps.engine.clock.now() - started };
  }

  private async failsAlone(sample: RunSample, token: CancellationToken): Promise<boolean> {
    const ev = await this.evaluate([sample], token, false);
    return this.check(ev, 0) !== null;
  }

  private async shrinkBatched(start: fc.Value<RunSample>, token: CancellationToken, onRound: (r: number) => void): Promise<{ value: RunSample; path: number[] }> {
    const cfg = this.doc.exorcist;
    let cur = start;
    const path: number[] = [];
    for (let round = 0; round < cfg.maxShrinkRounds && !token.cancelled; round++) {
      onRound(round);
      const stream = this.arb.shrink(cur.value, cur.context)[Symbol.iterator]();
      let offset = 0;
      let accepted: fc.Value<RunSample> | null = null;
      // Growing chunks (4, 16, 64, then batchSize): the first failing candidate is usually early in the stream, so a
      // round rarely pays for a full batch. Candidate indices are global within the stream, so the path is unchanged.
      for (let chunkNo = 0; ; chunkNo++) {
        const size = Math.min(cfg.batchSize, 4 * 4 ** chunkNo);
        const cands: Array<fc.Value<RunSample>> = [];
        for (let i = 0; i < size; i++) {
          const n = stream.next();
          if (n.done === true) break;
          cands.push(n.value);
        }
        if (cands.length === 0) break;
        // Probes (Tier 1 cross-engine checks) run on every search batch and on confirmation, not on shrink candidates.
        const ev = await this.evaluate(cands.map((c) => c.value), token, false);
        const hit = cands.findIndex((_c, j) => this.check(ev, j) !== null);
        if (hit >= 0) {
          accepted = cands[hit] ?? null;
          path.push(offset + hit);
          break;
        }
        offset += cands.length;
      }
      if (accepted === null) break;
      cur = accepted;
    }
    if (!(await this.failsAlone(cur.value, token))) return { value: start.value, path: [] };
    return { value: cur.value, path };
  }

  // ------------------------------------------------------------ replay

  async replay(artifact: ReplayArtifact, token: CancellationToken): Promise<ReplayOutcome> {
    const actual = await workbookHash(this.doc, this.deps.hasher);
    if (actual !== artifact.workbookHash) return { kind: 'hashMismatch', expected: artifact.workbookHash, actual };
    const [searchPath, digitsPart = ''] = artifact.path.split('|');
    const digits = digitsPart === '' ? [] : digitsPart.split(',').map(Number);
    let regenerated: RunSample | null = null;
    if (artifact.mode === 'batched') {
      const parts = (searchPath ?? '').split(':').filter((p) => p !== '').map(Number);
      const [startIndex, ...steps] = parts;
      if (startIndex !== undefined && Number.isInteger(startIndex)) {
        const mrng = new fc.Random(xoroshiro128plus(artifact.seed));
        let cur: fc.Value<RunSample> | null = null;
        for (let i = 0; i <= startIndex; i++) cur = this.arb.generate(mrng, 2 + Math.floor(Math.log10(i + 1)));
        for (const k of steps) {
          if (cur === null) break;
          let j = 0;
          let next: fc.Value<RunSample> | null = null;
          for (const s of this.arb.shrink(cur.value, cur.context)) {
            if (j++ === k) {
              next = s;
              break;
            }
          }
          cur = next;
        }
        regenerated = cur?.value ?? null;
      }
    } else if (searchPath !== undefined && searchPath !== '') {
      let last: RunSample | null = null;
      const property = fc.asyncProperty(this.arb, async (sample) => {
        last = sample;
        const r = await this.evaluateOne(sample, token, artifact.seed, 0, true);
        return r.violation === null;
      });
      const d = await fc.check(property, { seed: artifact.seed, path: searchPath, numRuns: artifact.numRuns, endOnFailure: true });
      regenerated = d.failed && d.counterexample !== null ? d.counterexample[0] : last;
    }
    const expected: RunSample = {
      base: this.doc.exorcist.inputs.map((inp) => {
        const f = artifact.failingInputs.find((x) => x.cell === inp.cell);
        return { cell: inp.cell, value: f === undefined ? null : decodeScalar(f.value) };
      }),
      steps: regenerated?.steps ?? [],
    };
    let exact = false;
    let sample = expected;
    if (regenerated !== null) {
      const simplified = this.applyDigits(regenerated, digits);
      exact = simplified.base.every((o) => {
        const e = expected.base.find((x) => x.cell === o.cell);
        return e !== undefined && Object.is(e.value, o.value);
      });
      if (exact) sample = simplified;
    }
    const r = await this.evaluateOne(sample, token, artifact.seed, 0, true);
    if (r.violation === null) return { kind: 'notReproduced', detail: 'the counterexample no longer violates any invariant or assertion' };
    return { kind: 'reproduced', exact, violation: r.violation, values: r.values };
  }
}

export function scenarioEdits(failingInputs: ReplayArtifact['failingInputs']): Array<{ readonly kind: 'setLiteral'; readonly key: CellKey; readonly value: ScalarValue }> {
  return failingInputs.map((f) => ({ kind: 'setLiteral', key: f.cell, value: decodeScalar(f.value) }));
}
