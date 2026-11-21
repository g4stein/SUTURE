import {
  assertionHolds, createWorkbookEngine, decodeScalar, fromReplayFragment, isCellError, isReplayArtifact, NEVER_CANCELLED, parseA1, parseCellKey,
  scenarioEdits, splitSheetPrefix, toCellKey, validateConfig, workbookHash,
  type CellAssertion, type CellKey, type CellSource, type CellValue, type DatasetMeta, type Edit, type EngineId, type ExecutionMode, type ExorcistConfig,
  type ExorcistProgress, type ExorcistVerdict, type LineagePath, type ReplayArtifact, type ReplayOutcome, type ScalarValue, type SutureDocument, type TableRef,
  type WorkbookEngine,
} from '@suture/core';
import { EngineHost, type Telemetry } from '../workers/engineHost.ts';
import { PyBridge, SqlBridge } from '../workers/bridges.ts';
import { detectIsolation, type IsolationInfo } from '../workers/isolation.ts';
import { isExorcistEvent, type ExorcistCommand } from '../workers/exorcistProtocol.ts';
import { sanitizeDatasetName } from '../workers/datasetName.ts';
import type { EngineName, EngineStatus } from '../workers/protocol.ts';
import { randomSeed, webClock, webCompressor, webHasher, yieldControl } from '../engines/hostAdapters.ts';
import { gatedPyEngine } from '../engines/gatedPy.ts';
import { checkImport } from '../import/routeFile.ts';
import { validateDocument } from '../import/validateDocument.ts';
import { saasRunwayDocument } from '../workbooks/saasRunway.ts';
import { ecommerceMarginDocument } from '../workbooks/ecommerceMargin.ts';
import { blankDocument } from '../workbooks/blank.ts';
import { formatValue } from './format.ts';

export type WorkbookId = 'saas' | 'ecommerce' | 'blank';
export type WorkbookChoice = WorkbookId | 'imported';

export const WORKBOOKS: ReadonlyArray<{ readonly id: WorkbookId; readonly label: string; readonly make: () => SutureDocument }> = [
  { id: 'saas', label: 'SaaS Cash Runway', make: saasRunwayDocument },
  { id: 'ecommerce', label: '100k-Row E-Commerce Margin Audit', make: ecommerceMarginDocument },
  { id: 'blank', label: 'Blank Workbook', make: blankDocument },
];

export type PanelTab = 'cell' | 'assertions' | 'audit';

export type ExorcistUi =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly seed: number; readonly progress: ExorcistProgress | null; readonly startedAt: number; readonly mode: ExecutionMode | null }
  | { readonly kind: 'finished'; readonly seed: number; readonly verdict: ExorcistVerdict; readonly fragment: string | null; readonly ms: number; readonly mode: ExecutionMode | null; readonly runs: number; readonly scenarios: number; readonly shrinkRounds: number }
  | { readonly kind: 'replaying'; readonly artifact: ReplayArtifact }
  | { readonly kind: 'replayed'; readonly artifact: ReplayArtifact; readonly outcome: ReplayOutcome }
  | { readonly kind: 'error'; readonly message: string };

export interface AssertionStatus {
  readonly id: string;
  readonly cell: CellKey;
  readonly label: string;
  /** null while a cell the assertion reads is still pending. */
  readonly ok: boolean | null;
  readonly detail: string;
}

export interface DatasetRow {
  readonly meta: DatasetMeta;
  readonly preview: TableRef;
}

export interface ImportReport {
  readonly id: number;
  readonly file: string;
  readonly ok: boolean;
  readonly message: string;
  readonly warnings: ReadonlyArray<string>;
}

export interface Toast {
  readonly id: number;
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

export interface EvalTelemetry {
  /** First recalculation of the open workbook, including any engine boot it triggered. */
  readonly firstEvalMs: number | null;
  /** Latest recalculation during which no engine booted or respawned: pure DAG + engine query time. */
  readonly warmEvalMs: number | null;
}

export interface Draft {
  readonly key: CellKey;
  readonly text: string;
  readonly where: 'cell' | 'bar';
}

/** X-Ray fracture focus: the artifact's lineage plus the values its cells take under the shrunk counterexample. */
export interface LineageFocus {
  readonly artifact: ReplayArtifact;
  readonly lineage: LineagePath;
  readonly callouts: ReadonlyMap<CellKey, CellValue>;
}

export interface Applied {
  readonly artifact: ReplayArtifact;
  readonly previous: ReadonlyArray<{ readonly key: CellKey; readonly source: CellSource | null }>;
}

export type Drawer = { readonly kind: 'cell'; readonly key: CellKey } | { readonly kind: 'dataset'; readonly name: string } | { readonly kind: 'datasets' };

export type ConfigCheck = { readonly ok: true; readonly mode: ExecutionMode } | { readonly ok: false; readonly message: string };

export interface AppSnapshot {
  readonly isolation: IsolationInfo;
  readonly gridReady: boolean;
  readonly engines: { readonly duckdb: EngineStatus; readonly pyodide: EngineStatus };
  readonly telemetry: Telemetry;
  readonly evals: EvalTelemetry;
  readonly workbook: WorkbookChoice;
  readonly title: string;
  readonly sheets: ReadonlyArray<string>;
  readonly activeSheet: string;
  readonly selection: CellKey;
  readonly draft: Draft | null;
  /** Bumps when committed values change (frame-coalesced). */
  readonly valueVersion: number;
  /** Bumps when cell sources change (edits, imports). */
  readonly editVersion: number;
  /** Bumps when sheets are added or a document is opened (column widths are recomputed). */
  readonly structureVersion: number;
  readonly xray: boolean;
  readonly focus: LineageFocus | null;
  readonly exorcist: ExorcistUi;
  readonly exorcistStale: boolean;
  readonly applied: Applied | null;
  readonly config: ExorcistConfig;
  readonly configCheck: ConfigCheck;
  readonly assertions: ReadonlyArray<AssertionStatus>;
  readonly datasets: ReadonlyArray<DatasetRow>;
  readonly imports: ReadonlyArray<ImportReport>;
  readonly largeTables: ReadonlyArray<{ readonly key: CellKey; readonly rowCount: number; readonly cols: number }>;
  readonly toasts: ReadonlyArray<Toast>;
  readonly drawer: Drawer | null;
  readonly panel: PanelTab;
  readonly untrustedPy: number;
  readonly replayPrompt: ReplayArtifact | null;
  readonly usesSql: boolean;
  readonly usesPy: boolean;
}

const LABELS: Readonly<Record<CellAssertion['kind'], string>> = { finite: 'finite', notError: 'not error', notNull: 'not null', gte: '≥', lte: '≤', gt: '>', lt: '<', between: 'between', monotonicWith: 'monotonic with' };
const RECALC = { tieBreak: { kind: 'rowMajor' as const }, token: NEVER_CANCELLED, sliceMs: 8 };
const TOAST_MS = 5000;

export function assertionLabel(a: CellAssertion): string {
  const op = (o: { readonly kind: 'const'; readonly value: number } | { readonly kind: 'cell'; readonly cell: CellKey }): string => (o.kind === 'const' ? String(o.value) : o.cell);
  switch (a.kind) {
    case 'gte': case 'lte': case 'gt': case 'lt': return `${LABELS[a.kind]} ${op(a.operand)}`;
    case 'between': return `between ${op(a.min)} and ${op(a.max)}`;
    case 'monotonicWith': return `${a.direction === 'nonDecreasing' ? 'non-decreasing' : 'non-increasing'} in ${a.input}`;
    default: return LABELS[a.kind];
  }
}

const upperKey = (k: string): string => k.toUpperCase();

export class AppStore {
  readonly host: EngineHost;
  private engine!: WorkbookEngine;
  private doc!: SutureDocument;
  private unsubscribe: () => void = () => undefined;
  private exorcistWorker: Worker | null = null;
  private sessionId = 0;
  private sessionHash: string | null = null;
  private snapshot: AppSnapshot;
  private readonly listeners = new Set<() => void>();
  private evalSeq = 0;
  private refreshQueued = false;
  private toastSeq = 0;
  private importSeq = 0;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private builtIns: Promise<Map<string, WorkbookId>> | null = null;
  /** Python cells that came from an imported file and have not been trusted (Spec 04 Req 6.5). Upper-cased keys. */
  private readonly untrusted = new Set<string>();
  /** Cell sources by key, rebuilt after every edit (the grid reads raw text from here). */
  private sources = new Map<string, CellSource>();
  private dialects = new Map<string, EngineId | 'literal'>();
  private lastIndexedDoc: SutureDocument | null = null;
  /** A replay that arrived for a document with untrusted Python; it runs once the user trusts the workbook. */
  private replayAfterTrust: ReplayArtifact | null = null;

  constructor() {
    const isolation = detectIsolation();
    this.host = new EngineHost(isolation);
    const blank = blankDocument();
    this.snapshot = {
      isolation, gridReady: false,
      engines: { duckdb: this.host.status('duckdb'), pyodide: this.host.status('pyodide') },
      telemetry: this.host.telemetry(), evals: { firstEvalMs: null, warmEvalMs: null },
      workbook: 'saas', title: '', sheets: [], activeSheet: '', selection: toCellKey({ sheet: 'Sheet1', row: 0, col: 0 }), draft: null,
      valueVersion: 0, editVersion: 0, structureVersion: 0, xray: false, focus: null,
      exorcist: { kind: 'idle' }, exorcistStale: false, applied: null, config: blank.exorcist, configCheck: { ok: false, message: 'no workbook' },
      assertions: [], datasets: [], imports: [], largeTables: [], toasts: [], drawer: null, panel: 'cell', untrustedPy: 0, replayPrompt: null,
      usesSql: false, usesPy: false,
    };
    this.host.subscribe(() => this.set({ engines: { duckdb: this.host.status('duckdb'), pyodide: this.host.status('pyodide') }, telemetry: this.host.telemetry() }));
    this.host.onPortReplaced((engine, portId, port, runningRequestId, cause, reason) => {
      const cmd: ExorcistCommand = { protocol: 1, kind: 'enginePortReplaced', engine, port, portId, runningRequestId, cause, reason };
      this.exorcistWorker?.postMessage(cmd, [port]);
    });
    this.open('saas', saasRunwayDocument());
  }

  // ------------------------------------------------------------------ external store

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): AppSnapshot => this.snapshot;

  private set(patch: Partial<AppSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ read model for the grid, inspector, and X-Ray

  source(key: CellKey): CellSource | null {
    return this.sources.get(upperKey(key)) ?? null;
  }

  dialect(key: CellKey): EngineId | 'literal' | null {
    return this.dialects.get(upperKey(key)) ?? null;
  }

  value(key: CellKey): CellValue | 'pending' {
    return this.engine.getValue(key);
  }

  precedents(key: CellKey): ReadonlyArray<CellKey> {
    return this.engine.precedents(key);
  }

  dependents(key: CellKey): ReadonlyArray<CellKey> {
    return this.engine.dependents(key);
  }

  graphVersion(): number {
    return this.engine.graphVersion();
  }

  /** Cells (with sources) on one sheet. */
  cellsOn(sheet: string): ReadonlyArray<CellSource> {
    const s = this.engine.definition().sheets.find((x) => x.name.toUpperCase() === sheet.toUpperCase());
    return s?.cells ?? [];
  }

  isBlocked(key: CellKey): boolean {
    return this.untrusted.has(upperKey(key));
  }

  dataset(name: string): DatasetRow | null {
    return this.snapshot.datasets.find((d) => d.meta.name === name) ?? null;
  }

  // ------------------------------------------------------------------ documents

  private makeEngine(doc: SutureDocument): WorkbookEngine {
    return createWorkbookEngine(doc.workbook, {
      sql: new SqlBridge(() => this.host.client('duckdb'), 'interactive'),
      py: gatedPyEngine(new PyBridge(() => this.host.client('pyodide'), 'interactive'), (cell) => this.untrusted.has(upperKey(cell))),
      clock: webClock,
      yieldControl,
    });
  }

  private open(id: WorkbookChoice, doc: SutureDocument, untrustedPython = false): void {
    this.unsubscribe();
    if (this.snapshot.exorcist.kind === 'running') this.stopExorcist();
    this.doc = doc;
    this.untrusted.clear();
    this.replayAfterTrust = null;
    this.engine = this.makeEngine(doc);
    const datasetEdits = this.snapshot.datasets.map((d) => ({ kind: 'registerDataset' as const, meta: d.meta }));
    if (datasetEdits.length > 0) this.engine.applyEdits(datasetEdits);
    this.unsubscribe = this.engine.subscribe((e) => {
      if (e.kind === 'cellCommitted' || e.kind === 'cellPending') this.queueRefresh();
    });
    this.reindex();
    if (untrustedPython) for (const [k, d] of this.dialects) if (d === 'py') this.untrusted.add(k);
    const sheets = this.engine.definition().sheets.map((s) => s.name);
    const first = sheets[0] ?? 'Sheet1';
    this.sessionHash = null;
    this.set({
      workbook: id, title: doc.title, sheets, activeSheet: first, selection: toCellKey({ sheet: first, row: 0, col: 0 }), draft: null,
      exorcist: { kind: 'idle' }, exorcistStale: false, applied: null, focus: null, config: doc.exorcist, configCheck: this.checkConfig(doc.exorcist), evals: { firstEvalMs: null, warmEvalMs: null },
      structureVersion: this.snapshot.structureVersion + 1, drawer: null, untrustedPy: this.untrusted.size,
    });
    this.refresh();
  }

  private reindex(): void {
    const sources = new Map<string, CellSource>();
    const dialects = new Map<string, EngineId | 'literal'>();
    for (const s of this.engine.definition().sheets) {
      for (const c of s.cells) {
        const k = upperKey(c.key);
        sources.set(k, c);
        const p = this.engine.getParsed(c.key);
        dialects.set(k, p === null || p.dialect === 'literal' ? 'literal' : p.dialect === 'formula' ? 'formula' : p.dialect);
      }
    }
    this.sources = sources;
    this.dialects = dialects;
    const all = [...dialects.values()];
    const config = this.doc === this.lastIndexedDoc ? this.snapshot.config : this.doc.exorcist;
    this.lastIndexedDoc = this.doc;
    this.set({ editVersion: this.snapshot.editVersion + 1, usesSql: all.includes('sql'), usesPy: all.includes('py'), configCheck: this.checkConfig(config) });
  }

  private checkConfig(config: ExorcistConfig): ConfigCheck {
    if (config.inputs.length === 0) return { ok: false, message: 'Add at least one fuzz domain on an input cell (Assertions & Domains).' };
    if (config.assertions.length === 0) return { ok: false, message: 'Add at least one assertion (Assertions & Domains).' };
    const r = validateConfig({ ...this.doc, exorcist: config }, this.engine);
    return r.ok ? { ok: true, mode: r.mode } : { ok: false, message: r.message };
  }

  /** Coalesces per-cell commit events into one snapshot per frame (no main-thread jank on 100k-row workbooks). */
  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  private refresh(): void {
    const look = (c: CellKey): CellValue => {
      const v = this.engine.getValue(c);
      return v === 'pending' ? null : v;
    };
    const assertions: AssertionStatus[] = this.snapshot.config.assertions.map((a) => {
      const reads = [a.cell, ...(a.kind === 'gte' || a.kind === 'lte' || a.kind === 'gt' || a.kind === 'lt' ? (a.operand.kind === 'cell' ? [a.operand.cell] : []) : [])];
      if (reads.some((c) => this.engine.getValue(c) === 'pending')) return { id: a.id, cell: a.cell, label: assertionLabel(a), ok: null, detail: 'waiting for the engine' };
      if (a.kind === 'monotonicWith') return { id: a.id, cell: a.cell, label: assertionLabel(a), ok: null, detail: 'checked by the Exorcist on paired scenarios' };
      const r = assertionHolds(a, look, null);
      return { id: a.id, cell: a.cell, label: assertionLabel(a), ok: r.ok, detail: r.detail };
    });
    const largeTables: Array<{ key: CellKey; rowCount: number; cols: number }> = [];
    for (const s of this.engine.definition().sheets) {
      for (const c of s.cells) {
        const v = this.engine.getValue(c.key);
        if (v !== 'pending' && v !== null && typeof v === 'object' && v.kind === 'table' && v.rowCount >= 1000) largeTables.push({ key: c.key, rowCount: v.rowCount, cols: v.schema.length });
      }
    }
    this.set({ assertions, largeTables, valueVersion: this.snapshot.valueVersion + 1 });
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

  /** First paint happens before any engine work (Spec 04 Req 4.2): the grid is ready, engines load on first use. */
  async start(): Promise<void> {
    // Deep link: ?workbook=saas | ecommerce | blank opens that built-in first (a blank start keeps both engines Lazy).
    const wanted = new URLSearchParams(location.search).get('workbook');
    const deep = WORKBOOKS.find((w) => w.id === wanted);
    if (deep !== undefined && deep.id !== this.snapshot.workbook) this.open(deep.id, deep.make());
    this.set({ gridReady: true });
    await new Promise((r) => setTimeout(r, 0));
    const hash = location.hash;
    if (hash.startsWith('#replay=v1.')) {
      const a = await fromReplayFragment(hash, webCompressor);
      if ('error' in a) {
        await this.recalc(true);
        this.set({ exorcist: { kind: 'error', message: `replay link: ${a.error}` }, panel: 'audit' });
        return;
      }
      await this.hydrateReplay(a);
      return;
    }
    await this.recalc(true);
  }

  async switchWorkbook(id: WorkbookId): Promise<void> {
    const w = WORKBOOKS.find((x) => x.id === id);
    if (w === undefined) return;
    this.open(id, w.make());
    await this.recalc(true);
  }

  currentDocument(): SutureDocument {
    return { ...this.doc, workbook: this.engine.definition(), exorcist: this.snapshot.config };
  }

  // ------------------------------------------------------------------ selection and editing

  setActiveSheet(name: string): void {
    const sheet = this.snapshot.sheets.find((s) => s.toUpperCase() === name.toUpperCase());
    if (sheet === undefined || sheet === this.snapshot.activeSheet) return;
    this.commitDraftIfAny();
    const firstCell = this.cellsOn(sheet)[0]?.key;
    this.set({ activeSheet: sheet, selection: firstCell ?? toCellKey({ sheet, row: 0, col: 0 }) });
  }

  select(key: CellKey): void {
    const c = parseCellKey(key);
    if (c === null) return;
    const sheet = this.snapshot.sheets.find((s) => s.toUpperCase() === c.sheet.toUpperCase()) ?? this.snapshot.activeSheet;
    const k = toCellKey({ sheet, row: c.row, col: c.col });
    if (this.snapshot.draft !== null && upperKey(this.snapshot.draft.key) !== upperKey(k)) this.commitDraftIfAny();
    this.set({ activeSheet: sheet, selection: k });
  }

  /** Name box (Req 2.2): `Sheet!A1`, `A1` on the active sheet, or a defined name. Returns an error message or null. */
  goTo(text: string): string | null {
    const t = text.trim();
    const name = this.engine.definition().names.find((n) => n.name.toUpperCase() === t.toUpperCase());
    if (name !== undefined) {
      const target = name.target.kind === 'cell' ? name.target.coord : { sheet: name.target.range.sheet, row: name.target.range.top, col: name.target.range.left };
      this.select(toCellKey(target));
      return null;
    }
    const split = splitSheetPrefix(t);
    if (split === null) return `"${t}" is not a reference`;
    const a1 = parseA1(split.rest);
    if (a1 === null) return `"${t}" is not a cell reference or defined name`;
    const sheet = split.sheet ?? this.snapshot.activeSheet;
    if (!this.snapshot.sheets.some((s) => s.toUpperCase() === sheet.toUpperCase())) return `there is no sheet named "${sheet}"`;
    this.select(toCellKey({ sheet, row: a1.row, col: a1.col }));
    return null;
  }

  beginEdit(key: CellKey, text: string | null, where: 'cell' | 'bar'): void {
    if (this.snapshot.draft !== null && upperKey(this.snapshot.draft.key) === upperKey(key)) {
      if (where !== this.snapshot.draft.where) this.set({ draft: { ...this.snapshot.draft, where } });
      return;
    }
    this.set({ draft: { key, text: text ?? this.source(key)?.raw ?? '', where } });
  }

  updateDraft(text: string): void {
    const d = this.snapshot.draft;
    if (d !== null) this.set({ draft: { ...d, text } });
  }

  cancelDraft(): void {
    if (this.snapshot.draft !== null) this.set({ draft: null });
  }

  private commitDraftIfAny(): void {
    if (this.snapshot.draft !== null) void this.commitDraft(null);
  }

  async commitDraft(move: 'down' | 'up' | 'right' | 'left' | null): Promise<void> {
    const d = this.snapshot.draft;
    if (d === null) return;
    this.set({ draft: null });
    if (move !== null) this.move(move);
    const before = this.source(d.key)?.raw ?? '';
    if (d.text === before) return;
    await this.applyUserEdits([d.text === '' ? { kind: 'clearCell', key: d.key } : { kind: 'setCell', key: d.key, raw: d.text }]);
  }

  async clearCell(key: CellKey): Promise<void> {
    if (this.source(key) === null) return;
    await this.applyUserEdits([{ kind: 'clearCell', key }]);
  }

  move(dir: 'down' | 'up' | 'right' | 'left', by = 1): void {
    const c = parseCellKey(this.snapshot.selection);
    if (c === null) return;
    const row = Math.min(1_048_575, Math.max(0, c.row + (dir === 'down' ? by : dir === 'up' ? -by : 0)));
    const col = Math.min(16_383, Math.max(0, c.col + (dir === 'right' ? by : dir === 'left' ? -by : 0)));
    this.set({ selection: toCellKey({ sheet: c.sheet, row, col }) });
  }

  selectCoord(row: number, col: number): void {
    this.set({ selection: toCellKey({ sheet: this.snapshot.activeSheet, row: Math.max(0, Math.min(1_048_575, row)), col: Math.max(0, Math.min(16_383, col)) }) });
  }

  /** Edits typed by the user: user-authored cells are trusted, and the previous verdict may become stale. */
  private async applyUserEdits(edits: ReadonlyArray<Edit>): Promise<void> {
    for (const e of edits) if (e.kind === 'setCell' || e.kind === 'clearCell' || e.kind === 'setLiteral') this.untrusted.delete(upperKey(e.key));
    this.engine.applyEdits(edits);
    this.reindex();
    this.set({ untrustedPy: this.untrusted.size });
    this.refresh();
    this.scheduleStaleCheck();
    await this.recalc(false);
  }

  addSheet(): void {
    let i = this.snapshot.sheets.length + 1;
    while (this.snapshot.sheets.some((s) => s.toUpperCase() === `SHEET${i}`)) i++;
    const name = `Sheet${i}`;
    this.engine.applyEdits([{ kind: 'addSheet', name }]);
    this.reindex();
    this.set({ sheets: this.engine.definition().sheets.map((s) => s.name), activeSheet: name, selection: toCellKey({ sheet: name, row: 0, col: 0 }), structureVersion: this.snapshot.structureVersion + 1 });
  }

  // ------------------------------------------------------------------ chrome state

  toggleXRay(on?: boolean): void {
    this.set({ xray: on ?? !this.snapshot.xray });
  }

  setPanel(panel: PanelTab): void {
    this.set({ panel });
  }

  openDrawer(d: Drawer | null): void {
    this.set({ drawer: d });
  }

  toast(kind: Toast['kind'], text: string): void {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.snapshot.toasts, { id, kind, text }].slice(-4) });
    setTimeout(() => this.dismissToast(id), TOAST_MS);
  }

  dismissToast(id: number): void {
    if (this.snapshot.toasts.some((t) => t.id === id)) this.set({ toasts: this.snapshot.toasts.filter((t) => t.id !== id) });
  }

  async retryEngine(engine: EngineName): Promise<void> {
    await this.host.retry(engine);
    await this.recalc(true);
  }

  async trustPython(): Promise<void> {
    this.untrusted.clear();
    this.set({ untrustedPy: 0 });
    this.toast('success', 'Python trusted for this workbook: its =PY() cells now run locally in the Pyodide worker.');
    await this.recalc(true);
    const pending = this.replayAfterTrust;
    this.replayAfterTrust = null;
    if (pending !== null) await this.replay(pending);
  }

  // ------------------------------------------------------------------ Exorcist configuration (Assertions & Domains)

  updateConfig(next: ExorcistConfig): void {
    this.set({ config: next, configCheck: this.checkConfig(next) });
    this.refresh();
    this.scheduleStaleCheck();
  }

  // ------------------------------------------------------------------ bring your own data (Spec 04 Req 6)

  private report(file: string, ok: boolean, message: string, warnings: ReadonlyArray<string> = []): void {
    this.set({ imports: [{ id: ++this.importSeq, file, ok, message, warnings }, ...this.snapshot.imports].slice(0, 12) });
    this.toast(ok ? 'success' : 'error', `${file}: ${message}`);
  }

  async importFiles(files: ReadonlyArray<File>): Promise<void> {
    for (const f of files) await this.importFile(f);
  }

  async importFile(file: File): Promise<void> {
    const name = file.name;
    const check = checkImport(name, file.size);
    if (!check.ok) return this.report(name, false, check.reason);
    if (check.kind === 'suture') return this.importDocument(name, await file.text());
    if (check.kind === 'replay') return this.importReplay(name, await file.text());
    const bytes = new Uint8Array(await file.arrayBuffer());
    const taken = this.snapshot.datasets.map((d) => d.meta.name);
    if (check.kind === 'csv' || check.kind === 'parquet') {
      const r = await this.host.registerDataset({ name: sanitizeDatasetName(name, taken), bytes, sourceFormat: check.kind, encoding: check.kind });
      if ('error' in r) return this.report(name, false, r.error);
      this.addDataset(r);
      this.set({ drawer: { kind: 'dataset', name: r.meta.name } });
      return this.report(name, true, `dataset "${r.meta.name}": ${r.meta.rowCount.toLocaleString('en-US')} rows × ${r.meta.schema.length} columns — query it with =SQL("SELECT … FROM ${r.meta.name}")`);
    }
    const wb = await this.host.ingestXlsx(name, bytes);
    if ('error' in wb) return this.report(name, false, wb.error);
    const existing = this.engine.definition().sheets.map((s) => s.name.toUpperCase());
    const added: string[] = [];
    const edits: Edit[] = [];
    for (const sh of wb.sheets) {
      let n = sh.name.slice(0, 31);
      for (let i = 2; existing.includes(n.toUpperCase()); i++) n = `${sh.name.slice(0, 26)} (${i})`;
      existing.push(n.toUpperCase());
      added.push(n);
      edits.push({ kind: 'addSheet', name: n });
      for (const c of sh.cells) {
        const key = toCellKey({ sheet: n, row: c.row, col: c.col });
        edits.push(c.kind === 'raw' ? { kind: 'setCell', key, raw: c.raw } : { kind: 'setLiteral', key, value: c.value });
      }
    }
    const names: string[] = [];
    for (const t of wb.tables) {
      const r = await this.host.registerDataset({ name: sanitizeDatasetName(`${name}_${t.sheet}`, [...taken, ...names]), bytes: t.ipc, sourceFormat: 'xlsx', encoding: 'arrow' });
      if ('error' in r) return this.report(name, false, r.error, wb.warnings);
      names.push(r.meta.name);
      this.addDataset(r);
    }
    this.engine.applyEdits(edits);
    this.reindex();
    // Spec 04 Req 6.5: Python that arrives in an imported file is blocked until the user trusts it.
    for (const sheetName of added) for (const c of this.cellsOn(sheetName)) if (this.dialect(c.key) === 'py') this.untrusted.add(upperKey(c.key));
    const sheets = this.engine.definition().sheets.map((s) => s.name);
    const first = added[0] ?? this.snapshot.activeSheet;
    this.set({ sheets, activeSheet: first, selection: toCellKey({ sheet: first, row: 0, col: 0 }), structureVersion: this.snapshot.structureVersion + 1, untrustedPy: this.untrusted.size });
    this.scheduleStaleCheck();
    await this.recalc(false);
    const vals = this.engine.definition().sheets.filter((s) => added.includes(s.name)).flatMap((s) => s.cells.map((c) => this.engine.getValue(c.key)));
    const nameErr = vals.filter((v) => v !== 'pending' && isCellError(v) && v.code === '#NAME?').length;
    const valueErr = vals.filter((v) => v !== 'pending' && isCellError(v) && v.code === '#VALUE!').length;
    return this.report(name, true, `sheets ${added.map((s) => `"${s}"`).join(', ')}; datasets ${names.join(', ')}; ${nameErr} cell(s) #NAME?, ${valueErr} cell(s) #VALUE!`, wb.warnings);
  }

  private addDataset(r: DatasetRow): void {
    this.engine.applyEdits([{ kind: 'registerDataset', meta: r.meta }]);
    this.set({ datasets: [...this.snapshot.datasets.filter((d) => d.meta.name !== r.meta.name), r] });
  }

  private async importDocument(file: string, text: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.report(file, false, 'not valid JSON');
    }
    const check = validateDocument(json);
    if (!check.ok) return this.report(file, false, `not a Suture workbook: ${check.path} ${check.message}`);
    const hash = await this.hashOf(check.document);
    const builtIn = (await this.builtInHashes()).get(hash);
    this.open(builtIn ?? 'imported', check.document, builtIn === undefined);
    this.report(file, true, `opened "${check.document.title}"${builtIn === undefined && this.untrusted.size > 0 ? ` — ${this.untrusted.size} Python cell(s) blocked until you trust the workbook` : ''}`);
    await this.recalc(true);
    const pending = this.snapshot.replayPrompt;
    if (pending !== null && pending.workbookHash === hash) {
      this.set({ replayPrompt: null });
      await this.replay(pending);
    }
  }

  // ------------------------------------------------------------------ Exorcist

  private async ensureExorcist(): Promise<{ worker: Worker; ports: Pick<Extract<ExorcistCommand, { kind: 'start' }>, 'duckdbPort' | 'duckdbPortId' | 'pyodidePort' | 'pyodidePortId'> }> {
    if (this.exorcistWorker === null) {
      // Top-level worker created on the main thread (zero nested workers).
      const w = new Worker(new URL('../workers/exorcist.worker.ts', import.meta.url), { type: 'module', name: 'suture-exorcist' });
      w.addEventListener('message', (e: MessageEvent<unknown>) => this.onExorcistEvent(e.data));
      this.exorcistWorker = w;
    }
    const d = this.snapshot.usesSql ? await this.host.connectClient('duckdb') : null;
    const p = this.snapshot.usesPy ? await this.host.connectClient('pyodide') : null;
    return { worker: this.exorcistWorker, ports: { duckdbPort: d?.port ?? null, duckdbPortId: d?.portId ?? null, pyodidePort: p?.port ?? null, pyodidePortId: p?.portId ?? null } };
  }

  async runExorcist(): Promise<void> {
    if (this.snapshot.exorcist.kind === 'running') return;
    if (this.untrusted.size > 0) {
      this.toast('error', 'Trust this workbook\'s Python first: the Exorcist would run its =PY() cells.');
      return;
    }
    const check = this.checkConfig(this.snapshot.config);
    if (!check.ok) {
      this.set({ exorcist: { kind: 'error', message: check.message }, panel: 'audit' });
      return;
    }
    this.commitDraftIfAny();
    const seed = randomSeed();
    const sessionId = ++this.sessionId;
    this.set({ exorcist: { kind: 'running', seed, progress: null, startedAt: performance.now(), mode: check.mode }, exorcistStale: false, panel: 'audit', focus: null });
    const document = this.currentDocument();
    this.sessionHash = await this.hashOf(document);
    const { worker, ports } = await this.ensureExorcist();
    if (sessionId !== this.sessionId) return;
    const cmd: ExorcistCommand = {
      protocol: 1, kind: 'start', sessionId, document, seed, ...ports,
      isolation: this.host.isolation, interruptBuffer: this.host.controlBuffer('pyodide'), duckdbCancelBuffer: this.host.controlBuffer('duckdb'),
    };
    worker.postMessage(cmd, [ports.duckdbPort, ports.pyodidePort].filter((x): x is MessagePort => x !== null));
  }

  stopExorcist(): void {
    const cmd: ExorcistCommand = { protocol: 1, kind: 'stop', sessionId: this.sessionId };
    this.exorcistWorker?.postMessage(cmd);
    this.sessionId++;
    this.set({ exorcist: { kind: 'idle' } });
  }

  async replay(artifact: ReplayArtifact): Promise<void> {
    // The Exorcist worker evaluates with its own engines (no trust gate), so a replay waits for trust like a session.
    if (this.untrusted.size > 0) {
      this.replayAfterTrust = artifact;
      this.set({ exorcist: { kind: 'error', message: 'Trust this workbook\'s Python to replay it: the replay would run its =PY() cells.' }, panel: 'audit' });
      return;
    }
    const sessionId = ++this.sessionId;
    this.set({ exorcist: { kind: 'replaying', artifact }, panel: 'audit' });
    const document = this.currentDocument();
    this.sessionHash = await this.hashOf(document);
    const { worker, ports } = await this.ensureExorcist();
    if (sessionId !== this.sessionId) return;
    const cmd: ExorcistCommand = {
      protocol: 1, kind: 'replay', sessionId, document, artifact, ...ports,
      isolation: this.host.isolation, interruptBuffer: this.host.controlBuffer('pyodide'), duckdbCancelBuffer: this.host.controlBuffer('duckdb'),
    };
    worker.postMessage(cmd, [ports.duckdbPort, ports.pyodidePort].filter((x): x is MessagePort => x !== null));
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
      case 'progress': {
        if (cur.kind !== 'running') break;
        // The confirm phase reports zero counters; keep the session's peak values so the totals stay visible.
        const p = cur.progress;
        const progress = p === null ? m.progress : { ...m.progress, runs: Math.max(p.runs, m.progress.runs), scenarios: Math.max(p.scenarios, m.progress.scenarios), shrinkRounds: Math.max(p.shrinkRounds, m.progress.shrinkRounds) };
        this.set({ exorcist: { ...cur, progress, mode: m.progress.mode } });
        break;
      }
      case 'verdict': {
        const run = cur.kind === 'running' ? cur : null;
        this.set({
          exorcist: {
            kind: 'finished', seed: run?.seed ?? 0, verdict: m.verdict, fragment: m.fragment, ms: run === null ? 0 : Math.round(performance.now() - run.startedAt),
            mode: m.verdict.kind === 'violated' ? m.verdict.artifact.mode : (run?.progress?.mode ?? run?.mode ?? null),
            runs: m.verdict.kind === 'passed' ? m.verdict.runs : (run?.progress?.runs ?? 0), scenarios: m.verdict.kind === 'passed' ? m.verdict.scenarios : (run?.progress?.scenarios ?? 0), shrinkRounds: run?.progress?.shrinkRounds ?? 0,
          },
        });
        if (m.verdict.kind === 'violated') void this.focusArtifact(m.verdict.artifact, null);
        break;
      }
      case 'replayed':
        if (cur.kind === 'replaying') {
          this.set({ exorcist: { kind: 'replayed', artifact: cur.artifact, outcome: m.outcome } });
          if (m.outcome.kind === 'reproduced') void this.focusArtifact(cur.artifact, m.outcome.values);
        }
        break;
      case 'failure':
        this.set({ exorcist: { kind: 'error', message: m.message } });
        break;
    }
  }

  /** The artifact the action bar works on: the latest violation or the latest replay. */
  currentArtifact(): ReplayArtifact | null {
    const x = this.snapshot.exorcist;
    if (x.kind === 'finished' && x.verdict.kind === 'violated') return x.verdict.artifact;
    if (x.kind === 'replayed' || x.kind === 'replaying') return x.artifact;
    return this.snapshot.focus?.artifact ?? null;
  }

  private violatedCell(a: ReplayArtifact): CellKey | null {
    const v = a.violatedAssertion;
    return v.tier === 2 ? v.assertion.cell : (v.cell ?? a.lineagePath.cells[a.lineagePath.cells.length - 1] ?? null);
  }

  /**
   * Fracture focus (Spec 04 §5.2 + callouts): the lineage values under the shrunk counterexample come from one
   * non-mutating evaluateScenarioBatch, so the callouts appear before (and independently of) Apply Counterexample.
   */
  private async focusArtifact(a: ReplayArtifact, known: ReadonlyMap<CellKey, CellValue> | null): Promise<void> {
    const overrides = a.failingInputs.map((f) => ({ cell: f.cell, value: decodeScalar(f.value) }));
    let callouts: Map<CellKey, CellValue> = new Map(overrides.map((o) => [o.cell, o.value]));
    if (known !== null) for (const [k, v] of known) callouts.set(k, v);
    this.set({ focus: { artifact: a, lineage: a.lineagePath, callouts }, xray: true });
    this.jumpToViolation(a);
    if (known === null) {
      try {
        const targets = a.lineagePath.cells.filter((c) => !overrides.some((o) => upperKey(o.cell) === upperKey(c)));
        const r = await this.engine.evaluateScenarioBatch({ scenarios: [overrides], targets, tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED });
        const values = r.values[0];
        if (values !== undefined) {
          callouts = new Map(callouts);
          for (const [k, v] of values) callouts.set(k, v);
        }
      } catch {
        // Callouts are an aid; the lineage still renders without intermediate values.
      }
      if (this.snapshot.focus?.artifact === a) this.set({ focus: { artifact: a, lineage: a.lineagePath, callouts } });
    }
  }

  private jumpToViolation(a: ReplayArtifact): void {
    const cell = this.violatedCell(a);
    if (cell !== null) this.select(cell);
  }

  /** Action bar: "Focus in X-Ray" (switches sheet if needed and activates the crimson fracture view). */
  focusInXRay(): void {
    const a = this.currentArtifact();
    if (a === null) return;
    if (this.snapshot.focus?.artifact === a) {
      this.set({ xray: true });
      this.jumpToViolation(a);
      return;
    }
    void this.focusArtifact(a, null);
  }

  /** Applies the shrunk counterexample as lossless setLiteral edits (Spec 04 Req 7.2) and recomputes the lineage live. */
  async applyCounterexample(): Promise<void> {
    const a = this.currentArtifact();
    if (a === null) return;
    const previous = this.snapshot.applied?.previous ?? a.failingInputs.map((f) => ({ key: f.cell, source: this.source(f.cell) }));
    this.engine.applyEdits(scenarioEdits(a.failingInputs));
    this.reindex();
    this.set({ applied: { artifact: a, previous } });
    this.refresh();
    if (this.snapshot.focus?.artifact !== a) void this.focusArtifact(a, null);
    else this.set({ xray: true });
    await this.recalc(false);
    this.scheduleStaleCheck();
  }

  /** Action bar: "Reset Base Values" — restores the input cells that Apply Counterexample overwrote. */
  async resetBaseValues(): Promise<void> {
    const applied = this.snapshot.applied;
    if (applied === null) return;
    const edits: Edit[] = applied.previous.map((p): Edit => {
      if (p.source === null) return { kind: 'clearCell', key: p.key };
      if (p.source.literal !== undefined) return { kind: 'setLiteral', key: p.key, value: p.source.literal };
      return { kind: 'setCell', key: p.key, raw: p.source.raw };
    });
    this.engine.applyEdits(edits);
    this.reindex();
    this.set({ applied: null });
    this.refresh();
    await this.recalc(false);
    this.scheduleStaleCheck();
    this.toast('info', 'Base values restored.');
  }

  // ------------------------------------------------------------------ replay links and files

  async copyReplayLink(): Promise<void> {
    const x = this.snapshot.exorcist;
    if (x.kind !== 'finished' || x.verdict.kind !== 'violated') return;
    if (x.fragment === null) {
      this.downloadReplay();
      this.toast('info', 'This replay is longer than 8,192 characters, so it was downloaded as replay JSON instead of copied as a link.');
      return;
    }
    const url = `${location.origin}${location.pathname}#${x.fragment}`;
    try {
      await navigator.clipboard.writeText(url);
      const builtIn = (await this.builtInHashes()).has(x.verdict.artifact.workbookHash);
      this.toast('success', builtIn ? 'Replay link copied. Opening it replays this counterexample exactly.' : 'Replay link copied. This workbook is not built in, so share its exported .suture.json with the link.');
    } catch {
      this.toast('error', 'The clipboard is not available here. Use Download Replay JSON instead.');
    }
  }

  private download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  downloadReplay(): void {
    const a = this.currentArtifact();
    if (a === null) return;
    this.download(`suture-replay-${a.seed}.json`, `${JSON.stringify(a, null, 2)}\n`);
  }

  exportWorkbook(): void {
    const doc = this.currentDocument();
    const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workbook';
    this.download(`${slug}.suture.json`, `${JSON.stringify(doc, null, 2)}\n`);
  }

  private async importReplay(file: string, text: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.report(file, false, 'not valid JSON');
    }
    if (!isReplayArtifact(json)) return this.report(file, false, 'not a Suture replay artifact');
    this.report(file, true, `replay for workbook ${json.workbookHash.slice(0, 12)}…`);
    await this.hydrateReplay(json);
  }

  /** Spec 04 Req 7.3: open the built-in whose hash matches, use the open document if it matches, or ask for the document. */
  private async hydrateReplay(a: ReplayArtifact): Promise<void> {
    const current = await this.hashOf(this.currentDocument());
    if (current === a.workbookHash) {
      await this.recalc(true);
      await this.replay(a);
      return;
    }
    const builtIn = (await this.builtInHashes()).get(a.workbookHash);
    if (builtIn !== undefined) {
      const w = WORKBOOKS.find((x) => x.id === builtIn);
      if (w !== undefined) this.open(builtIn, w.make());
      await this.recalc(true);
      await this.replay(a);
      return;
    }
    await this.recalc(true);
    this.set({ replayPrompt: a, panel: 'audit' });
  }

  dismissReplayPrompt(): void {
    this.set({ replayPrompt: null });
  }

  private async hashOf(doc: SutureDocument): Promise<string> {
    const canonical = this.makeEngine(doc).definition();
    return workbookHash({ ...doc, workbook: canonical }, webHasher);
  }

  /** Hashes of the built-in workbooks, computed over the engine's canonical definition (as sessions hash them). */
  private builtInHashes(): Promise<Map<string, WorkbookId>> {
    this.builtIns ??= (async () => {
      const out = new Map<string, WorkbookId>();
      for (const w of WORKBOOKS) out.set(await this.hashOf(w.make()), w.id);
      return out;
    })();
    return this.builtIns;
  }

  /**
   * Req 7.5 / Spec 04 §2: a document change WHILE a session runs marks its verdict stale (debounced 200 ms). Edits after
   * the verdict (Apply Counterexample, Reset Base Values, exploring) do not: the artifact still names its workbook hash.
   */
  private scheduleStaleCheck(): void {
    if (this.sessionHash === null || this.snapshot.exorcist.kind !== 'running') return;
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      const expected = this.sessionHash;
      if (expected === null) return;
      void this.hashOf(this.currentDocument()).then((h) => {
        if (this.sessionHash === expected && h !== expected) this.set({ exorcistStale: true });
      });
    }, 200);
  }

  /** Text for a cell's value, for callouts and the lineage strip. */
  describe(v: CellValue | undefined): string {
    return v === undefined ? '—' : formatValue(v);
  }

  /** Literal numeric value of an input cell, for fuzz-domain defaults. */
  literalNumber(key: CellKey): number | null {
    const v = this.engine.getValue(key);
    return this.dialect(key) === 'literal' && typeof v === 'number' ? v : null;
  }

  scalarAt(key: CellKey): ScalarValue | null {
    const v = this.engine.getValue(key);
    return v === 'pending' || (v !== null && typeof v === 'object') ? null : v;
  }
}
