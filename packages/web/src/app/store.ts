import {
  assertionHolds, compareRowMajor, createWorkbookEngine, fromReplayFragment, isCellError, NEVER_CANCELLED, parseCellKey, scenarioEdits, toCellKey, workbookHash,
  type CellKey, type CellValue, type DatasetMeta, type EngineId, type ExorcistProgress, type ExorcistVerdict, type ReplayArtifact, type ReplayOutcome,
  type SutureDocument, type TableRef, type WorkbookEngine,
} from '@suture/core';
import { EngineHost, type Telemetry } from '../workers/engineHost.ts';
import { PyBridge, SqlBridge } from '../workers/bridges.ts';
import { detectIsolation, type IsolationInfo } from '../workers/isolation.ts';
import { isExorcistEvent, type ExorcistCommand } from '../workers/exorcistProtocol.ts';
import { sanitizeDatasetName } from '../workers/datasetName.ts';
import type { EngineStatus } from '../workers/protocol.ts';
import { randomSeed, webClock, webCompressor, webHasher, yieldControl } from '../engines/hostAdapters.ts';
import { sliceDocument } from '../slice/sliceDocument.ts';
import { saasRunwayDocument } from '../workbooks/saasRunway.ts';
import { ecommerceMarginDocument } from '../workbooks/ecommerceMargin.ts';

export type WorkbookId = 'slice' | 'saas' | 'ecommerce';
export const WORKBOOKS: ReadonlyArray<{ readonly id: WorkbookId; readonly label: string; readonly make: () => SutureDocument }> = [
  { id: 'slice', label: 'Vertical slice', make: sliceDocument },
  { id: 'saas', label: 'Flagship 1 · SaaS Cash Runway', make: saasRunwayDocument },
  { id: 'ecommerce', label: 'Flagship 2 · 100k-Row Margin Audit', make: ecommerceMarginDocument },
];

export type ExorcistUi =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly seed: number; readonly progress: ExorcistProgress | null }
  | { readonly kind: 'finished'; readonly seed: number; readonly verdict: ExorcistVerdict; readonly fragment: string | null; readonly ms: number }
  | { readonly kind: 'replaying'; readonly artifact: ReplayArtifact }
  | { readonly kind: 'replayed'; readonly artifact: ReplayArtifact; readonly outcome: ReplayOutcome }
  | { readonly kind: 'error'; readonly message: string };

export interface AssertionStatus {
  readonly id: string;
  readonly cell: CellKey;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CellRow {
  readonly key: CellKey;
  readonly sheet: string;
  readonly a1: string;
  readonly raw: string;
  readonly engine: EngineId;
  readonly literal: boolean;
  readonly value: CellValue | 'pending';
}

export interface DatasetRow {
  readonly meta: DatasetMeta;
  readonly preview: TableRef;
}

export interface ImportReport {
  readonly file: string;
  readonly ok: boolean;
  readonly message: string;
  readonly warnings: ReadonlyArray<string>;
}

/** Spec 04 telemetry, split so WASM cold boot is never reported as DAG latency. */
export interface EvalTelemetry {
  /** First recalculation of the open workbook, including any engine boot it triggered. */
  readonly firstEvalMs: number | null;
  /** Latest recalculation during which no engine booted or respawned: pure DAG + engine query time. */
  readonly warmEvalMs: number | null;
}

export interface AppSnapshot {
  readonly isolation: IsolationInfo;
  readonly gridReady: boolean;
  readonly engines: { readonly duckdb: EngineStatus; readonly pyodide: EngineStatus };
  readonly telemetry: Telemetry;
  readonly evals: EvalTelemetry;
  readonly workbook: WorkbookId | 'imported';
  readonly title: string;
  readonly rows: ReadonlyArray<CellRow>;
  readonly assertions: ReadonlyArray<AssertionStatus>;
  readonly datasets: ReadonlyArray<DatasetRow>;
  readonly imports: ReadonlyArray<ImportReport>;
  readonly exorcist: ExorcistUi;
  readonly applied: ReplayArtifact | null;
  readonly generation: number;
}

const LABELS: Readonly<Record<string, string>> = { finite: 'finite', notError: 'notError', notNull: 'notNull', gte: '≥', lte: '≤', gt: '>', lt: '<', between: 'between', monotonicWith: 'monotonic' };
const RECALC = { tieBreak: { kind: 'rowMajor' as const }, token: NEVER_CANCELLED, sliceMs: 8 };

export class AppStore {
  readonly host: EngineHost;
  private engine!: WorkbookEngine;
  private doc!: SutureDocument;
  private unsubscribe: () => void = () => undefined;
  private exorcistWorker: Worker | null = null;
  private sessionId = 0;
  private exorcistStarted = 0;
  private snapshot: AppSnapshot;
  private readonly listeners = new Set<() => void>();
  private evalSeq = 0;
  private refreshQueued = false;

  constructor() {
    const isolation = detectIsolation();
    this.host = new EngineHost(isolation);
    this.snapshot = {
      isolation, gridReady: false,
      engines: { duckdb: this.host.status('duckdb'), pyodide: this.host.status('pyodide') },
      telemetry: this.host.telemetry(), evals: { firstEvalMs: null, warmEvalMs: null },
      workbook: 'slice', title: '', rows: [], assertions: [], datasets: [], imports: [],
      exorcist: { kind: 'idle' }, applied: null, generation: 0,
    };
    this.host.subscribe(() => this.set({ engines: { duckdb: this.host.status('duckdb'), pyodide: this.host.status('pyodide') }, telemetry: this.host.telemetry() }));
    this.host.onPortReplaced((engine, portId, port, runningRequestId, cause, reason) => {
      const cmd: ExorcistCommand = { protocol: 1, kind: 'enginePortReplaced', engine, port, portId, runningRequestId, cause, reason };
      this.exorcistWorker?.postMessage(cmd, [port]);
    });
    this.open('slice', WORKBOOKS[0]?.make() ?? sliceDocument());
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): AppSnapshot => this.snapshot;

  private set(patch: Partial<AppSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private open(id: WorkbookId | 'imported', doc: SutureDocument): void {
    this.unsubscribe();
    this.doc = doc;
    this.engine = createWorkbookEngine(doc.workbook, {
      sql: new SqlBridge(() => this.host.client('duckdb'), 'interactive'),
      py: new PyBridge(() => this.host.client('pyodide'), 'interactive'),
      clock: webClock,
      yieldControl,
    });
    const datasetEdits = this.snapshot.datasets.map((d) => ({ kind: 'registerDataset' as const, meta: d.meta }));
    if (datasetEdits.length > 0) this.engine.applyEdits(datasetEdits);
    this.unsubscribe = this.engine.subscribe((e) => {
      if (e.kind === 'cellCommitted' || e.kind === 'cellPending') this.queueRefresh();
    });
    this.set({ workbook: id, title: doc.title, exorcist: { kind: 'idle' }, applied: null, evals: { firstEvalMs: null, warmEvalMs: null } });
    this.refresh();
  }

  /** Coalesces per-cell commit events into one snapshot per frame (zero main-thread jank on 100k-row workbooks). */
  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  private refresh(): void {
    const def = this.engine.definition();
    const sheets = def.sheets.map((s) => s.name);
    const rows: CellRow[] = def.sheets.flatMap((s) => s.cells.map((c) => {
      const parsed = this.engine.getParsed(c.key);
      const engine: EngineId = parsed?.dialect === 'sql' ? 'sql' : parsed?.dialect === 'py' ? 'py' : 'formula';
      return { key: c.key, sheet: s.name, a1: c.key.slice(c.key.lastIndexOf('!') + 1), raw: c.raw, engine, literal: parsed?.dialect === 'literal', value: this.engine.getValue(c.key) };
    }));
    rows.sort((a, b) => compareRowMajor(parseCellKey(a.key) ?? { sheet: '', row: 0, col: 0 }, parseCellKey(b.key) ?? { sheet: '', row: 0, col: 0 }, sheets));
    const look = (c: CellKey): CellValue => {
      const v = this.engine.getValue(c);
      return v === 'pending' ? null : v;
    };
    const anyPending = this.doc.exorcist.assertions.some((a) => this.engine.getValue(a.cell) === 'pending');
    const assertions: AssertionStatus[] = anyPending ? [] : this.doc.exorcist.assertions.map((a) => {
      const r = assertionHolds(a, look, null);
      const operand = a.kind === 'gte' || a.kind === 'lte' || a.kind === 'gt' || a.kind === 'lt' ? ` ${a.operand.kind === 'const' ? a.operand.value : a.operand.cell}` : '';
      return { id: a.id, cell: a.cell, label: `${LABELS[a.kind] ?? a.kind}${operand}`, ok: r.ok, detail: r.detail };
    });
    this.set({ rows, assertions });
  }

  /** Runs a recalculation and classifies its time as first (cold, may include engine boot) or warm. */
  private async recalc(full: boolean): Promise<void> {
    const seq = ++this.evalSeq;
    const bootsBefore = this.boots();
    const t0 = performance.now();
    await (full ? this.engine.recalculateAll(RECALC) : this.engine.recalculate(RECALC));
    if (seq !== this.evalSeq) return;
    const ms = Math.round(performance.now() - t0);
    const booted = this.boots() !== bootsBefore;
    const evals = this.snapshot.evals;
    // A generation that booted or respawned an engine is never reported as warm DAG latency.
    this.set({ evals: evals.firstEvalMs === null ? { ...evals, firstEvalMs: ms } : booted ? evals : { ...evals, warmEvalMs: ms } });
    this.refresh();
  }

  private boots(): string {
    const t = this.host.telemetry();
    return `${t.duckdbInitMs ?? '-'}:${t.pyodideInitMs ?? '-'}:${t.respawns.duckdb}:${t.respawns.pyodide}`;
  }

  /** First paint happens before any engine work (Spec 04 Req 4.2): the grid is ready, engines stay Lazy until needed. */
  async start(): Promise<void> {
    this.set({ gridReady: true });
    await new Promise((r) => setTimeout(r, 0));
    const hash = location.hash;
    if (hash.startsWith('#replay=v1.')) {
      const id = await this.workbookForFragment(hash);
      if (id !== null && id !== this.snapshot.workbook) this.open(id, (WORKBOOKS.find((w) => w.id === id)?.make ?? sliceDocument)());
    }
    await this.recalc(true);
    if (hash.startsWith('#replay=v1.')) await this.replayFromFragment(hash);
  }

  async switchWorkbook(id: WorkbookId): Promise<void> {
    if (this.snapshot.exorcist.kind === 'running') this.stopExorcist();
    this.open(id, (WORKBOOKS.find((w) => w.id === id)?.make ?? sliceDocument)());
    await this.recalc(true);
  }

  async edit(cell: CellKey, raw: string): Promise<void> {
    const g = this.engine.applyEdits([{ kind: 'setCell', key: cell, raw }]);
    this.set({ generation: g, applied: null });
    this.refresh();
    await this.recalc(false);
  }

  async addCell(keyText: string, raw: string): Promise<string | null> {
    const parsed = parseCellKey(keyText.includes('!') ? keyText : `${this.engine.definition().sheets[0]?.name ?? 'Sheet1'}!${keyText}`);
    if (parsed === null) return `"${keyText}" is not a cell reference like Data!A1`;
    const sheets = this.engine.definition().sheets.map((s) => s.name);
    const edits = sheets.some((s) => s.toUpperCase() === parsed.sheet.toUpperCase()) ? [] : [{ kind: 'addSheet' as const, name: parsed.sheet }];
    const g = this.engine.applyEdits([...edits, { kind: 'setCell', key: toCellKey(parsed), raw }]);
    this.set({ generation: g, applied: null });
    this.refresh();
    await this.recalc(false);
    return null;
  }

  private currentDocument(): SutureDocument {
    return { ...this.doc, workbook: this.engine.definition() };
  }

  // ------------------------------------------------------------------ BYO data (Spec 04 Req 6)

  async importFile(file: File): Promise<void> {
    const name = file.name;
    const lower = name.toLowerCase();
    const report = (r: ImportReport): void => this.set({ imports: [r, ...this.snapshot.imports].slice(0, 10) });
    if (file.size > 256 * 1024 * 1024) return report({ file: name, ok: false, message: 'files larger than 256 MiB are not supported', warnings: [] });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const taken = this.snapshot.datasets.map((d) => d.meta.name);
    if (lower.endsWith('.csv') || lower.endsWith('.parquet')) {
      const encoding = lower.endsWith('.csv') ? 'csv' : 'parquet';
      const r = await this.host.registerDataset({ name: sanitizeDatasetName(name, taken), bytes, sourceFormat: encoding, encoding });
      if ('error' in r) return report({ file: name, ok: false, message: r.error, warnings: [] });
      this.addDataset(r);
      return report({ file: name, ok: true, message: `dataset "${r.meta.name}": ${r.meta.rowCount.toLocaleString('en-US')} rows × ${r.meta.schema.length} columns`, warnings: [] });
    }
    if (lower.endsWith('.xlsx')) {
      const wb = await this.host.ingestXlsx(name, bytes);
      if ('error' in wb) return report({ file: name, ok: false, message: wb.error, warnings: [] });
      const existing = this.engine.definition().sheets.map((s) => s.name.toUpperCase());
      const rename = new Map<string, string>();
      const edits: Parameters<WorkbookEngine['applyEdits']>[0][number][] = [];
      for (const sh of wb.sheets) {
        let n = sh.name.slice(0, 31);
        for (let i = 2; existing.includes(n.toUpperCase()); i++) n = `${sh.name.slice(0, 26)} (${i})`;
        existing.push(n.toUpperCase());
        rename.set(sh.name, n);
        edits.push({ kind: 'addSheet', name: n });
        for (const c of sh.cells) {
          const key = toCellKey({ sheet: n, row: c.row, col: c.col });
          edits.push(c.kind === 'raw' ? { kind: 'setCell', key, raw: c.raw } : { kind: 'setLiteral', key, value: c.value });
        }
      }
      const names: string[] = [];
      for (const t of wb.tables) {
        const r = await this.host.registerDataset({ name: sanitizeDatasetName(`${name}_${t.sheet}`, [...taken, ...names]), bytes: t.ipc, sourceFormat: 'xlsx', encoding: 'arrow' });
        if ('error' in r) return report({ file: name, ok: false, message: r.error, warnings: [...wb.warnings] });
        names.push(r.meta.name);
        this.addDataset(r);
      }
      const g = this.engine.applyEdits(edits);
      this.set({ generation: g, workbook: this.snapshot.workbook });
      await this.recalc(false);
      const added = [...rename.values()];
      const vals = this.engine.definition().sheets.filter((s) => added.includes(s.name)).flatMap((s) => s.cells.map((c) => this.engine.getValue(c.key)));
      const nameErr = vals.filter((v) => v !== 'pending' && isCellError(v) && v.code === '#NAME?').length;
      const valueErr = vals.filter((v) => v !== 'pending' && isCellError(v) && v.code === '#VALUE!').length;
      return report({
        file: name, ok: true,
        message: `sheets ${added.map((s) => `"${s}"`).join(', ')}; datasets ${names.join(', ')}; ${nameErr} cell(s) #NAME?, ${valueErr} cell(s) #VALUE!`,
        warnings: [...wb.warnings],
      });
    }
    return report({ file: name, ok: false, message: 'supported files: .csv, .parquet, .xlsx', warnings: [] });
  }

  private addDataset(r: DatasetRow): void {
    this.engine.applyEdits([{ kind: 'registerDataset', meta: r.meta }]);
    this.set({ datasets: [...this.snapshot.datasets.filter((d) => d.meta.name !== r.meta.name), r] });
  }

  // ------------------------------------------------------------------ Exorcist

  private async ensureExorcist(): Promise<{ worker: Worker; ports: Pick<Extract<ExorcistCommand, { kind: 'start' }>, 'duckdbPort' | 'duckdbPortId' | 'pyodidePort' | 'pyodidePortId'> }> {
    if (this.exorcistWorker === null) {
      // Top-level worker created on the main thread (zero nested workers).
      const w = new Worker(new URL('../workers/exorcist.worker.ts', import.meta.url), { type: 'module', name: 'suture-exorcist' });
      w.addEventListener('message', (e: MessageEvent<unknown>) => this.onExorcistEvent(e.data));
      this.exorcistWorker = w;
    }
    const usesSql = this.snapshot.rows.some((r) => r.engine === 'sql');
    const usesPy = this.snapshot.rows.some((r) => r.engine === 'py');
    const d = usesSql ? await this.host.connectClient('duckdb') : null;
    const p = usesPy ? await this.host.connectClient('pyodide') : null;
    return { worker: this.exorcistWorker, ports: { duckdbPort: d?.port ?? null, duckdbPortId: d?.portId ?? null, pyodidePort: p?.port ?? null, pyodidePortId: p?.portId ?? null } };
  }

  async runExorcist(): Promise<void> {
    const seed = randomSeed();
    const sessionId = ++this.sessionId;
    this.set({ exorcist: { kind: 'running', seed, progress: null }, applied: null });
    const { worker, ports } = await this.ensureExorcist();
    this.exorcistStarted = performance.now();
    const cmd: ExorcistCommand = {
      protocol: 1, kind: 'start', sessionId, document: this.currentDocument(), seed, ...ports,
      isolation: this.host.isolation, interruptBuffer: this.host.controlBuffer('pyodide'), duckdbCancelBuffer: this.host.controlBuffer('duckdb'),
    };
    worker.postMessage(cmd, [ports.duckdbPort, ports.pyodidePort].filter((x): x is MessagePort => x !== null));
  }

  async replay(artifact: ReplayArtifact): Promise<void> {
    const sessionId = ++this.sessionId;
    this.set({ exorcist: { kind: 'replaying', artifact } });
    const { worker, ports } = await this.ensureExorcist();
    const cmd: ExorcistCommand = {
      protocol: 1, kind: 'replay', sessionId, document: this.currentDocument(), artifact, ...ports,
      isolation: this.host.isolation, interruptBuffer: this.host.controlBuffer('pyodide'), duckdbCancelBuffer: this.host.controlBuffer('duckdb'),
    };
    worker.postMessage(cmd, [ports.duckdbPort, ports.pyodidePort].filter((x): x is MessagePort => x !== null));
  }

  /** Hashes of the built-in workbooks, computed over the engine's canonical definition (as sessions hash them). */
  private async builtInHashes(): Promise<Map<string, WorkbookId>> {
    const out = new Map<string, WorkbookId>();
    for (const w of WORKBOOKS) {
      const d = w.make();
      const canonical = createWorkbookEngine(d.workbook, { sql: new SqlBridge(() => this.host.client('duckdb'), 'interactive'), py: new PyBridge(() => this.host.client('pyodide'), 'interactive'), clock: webClock, yieldControl }).definition();
      out.set(await workbookHash({ ...d, workbook: canonical }, webHasher), w.id);
    }
    return out;
  }

  private async workbookForFragment(fragment: string): Promise<WorkbookId | null> {
    const a = await fromReplayFragment(fragment, webCompressor);
    if ('error' in a) return null;
    return (await this.builtInHashes()).get(a.workbookHash) ?? null;
  }

  private async replayFromFragment(fragment: string): Promise<void> {
    const a = await fromReplayFragment(fragment, webCompressor);
    if ('error' in a) {
      this.set({ exorcist: { kind: 'error', message: a.error } });
      return;
    }
    const expected = await workbookHash(this.currentDocument(), webHasher);
    if (a.workbookHash !== expected) {
      this.set({ exorcist: { kind: 'error', message: `replay link is for workbook ${a.workbookHash}, which is not a built-in workbook` } });
      return;
    }
    await this.replay(a);
  }

  private onExorcistEvent(m: unknown): void {
    if (!isExorcistEvent(m)) return;
    if (m.kind === 'respawnRequest') {
      this.host.requestRespawn(m.engine, m.portId, m.requestId, m.cause);
      return;
    }
    if ('sessionId' in m && m.sessionId !== this.sessionId) return;
    const cur = this.snapshot.exorcist;
    switch (m.kind) {
      case 'progress':
        if (cur.kind === 'running') this.set({ exorcist: { ...cur, progress: m.progress } });
        break;
      case 'verdict':
        this.set({ exorcist: { kind: 'finished', seed: cur.kind === 'running' ? cur.seed : 0, verdict: m.verdict, fragment: m.fragment, ms: Math.round(performance.now() - this.exorcistStarted) } });
        break;
      case 'replayed':
        if (cur.kind === 'replaying') this.set({ exorcist: { kind: 'replayed', artifact: cur.artifact, outcome: m.outcome } });
        break;
      case 'failure':
        this.set({ exorcist: { kind: 'error', message: m.message } });
        break;
    }
  }

  stopExorcist(): void {
    const cmd: ExorcistCommand = { protocol: 1, kind: 'stop', sessionId: this.sessionId };
    this.exorcistWorker?.postMessage(cmd);
    this.set({ exorcist: { kind: 'idle' } });
  }

  /** Applies the shrunk counterexample as lossless setLiteral edits (Spec 04 Req 7.2) and recomputes the lineage live. */
  async applyCounterexample(artifact: ReplayArtifact): Promise<void> {
    const g = this.engine.applyEdits(scenarioEdits(artifact.failingInputs));
    this.set({ generation: g, applied: artifact });
    this.refresh();
    await this.recalc(false);
    this.refresh();
  }
}
