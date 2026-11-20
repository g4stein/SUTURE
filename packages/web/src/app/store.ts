import {
  assertionHolds, createWorkbookEngine, fromReplayFragment, isCellError, NEVER_CANCELLED, scenarioEdits, workbookHash,
  type CellKey, type CellValue, type ExorcistProgress, type ExorcistVerdict, type ReplayArtifact, type ReplayOutcome,
  type SutureDocument, type WorkbookEngine,
} from '@suture/core';
import { EngineHost, type Telemetry } from '../workers/engineHost.ts';
import { PyBridge, SqlBridge } from '../workers/bridges.ts';
import { detectIsolation, type IsolationInfo } from '../workers/isolation.ts';
import { isExorcistEvent, type ExorcistCommand } from '../workers/exorcistProtocol.ts';
import type { EngineStatus } from '../workers/protocol.ts';
import { randomSeed, webClock, webCompressor, webHasher, yieldControl } from '../engines/hostAdapters.ts';
import { k, sliceDocument } from '../slice/sliceDocument.ts';

export type ExorcistUi =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly seed: number; readonly progress: ExorcistProgress | null }
  | { readonly kind: 'finished'; readonly seed: number; readonly verdict: ExorcistVerdict; readonly fragment: string | null; readonly ms: number }
  | { readonly kind: 'replaying'; readonly artifact: ReplayArtifact }
  | { readonly kind: 'replayed'; readonly artifact: ReplayArtifact; readonly outcome: ReplayOutcome }
  | { readonly kind: 'error'; readonly message: string };

export interface AssertionStatus {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface AppSnapshot {
  readonly isolation: IsolationInfo;
  readonly gridReady: boolean;
  readonly engines: { readonly duckdb: EngineStatus; readonly pyodide: EngineStatus };
  readonly telemetry: Telemetry;
  readonly lastEvalMs: number | null;
  readonly values: ReadonlyMap<CellKey, CellValue | 'pending'>;
  readonly raws: ReadonlyMap<CellKey, string>;
  readonly assertions: ReadonlyArray<AssertionStatus>;
  readonly exorcist: ExorcistUi;
  readonly applied: ReplayArtifact | null;
  readonly generation: number;
}

export const SLICE_CELLS: ReadonlyArray<CellKey> = [k('C1'), k('C2'), k('E1'), k('A1'), k('B1'), k('D1')];

const LABELS: Readonly<Record<string, string>> = { finite: 'finite', notError: 'notError', gte: '≥ 0' };

export class AppStore {
  readonly host: EngineHost;
  private readonly engine: WorkbookEngine;
  private doc: SutureDocument = sliceDocument();
  private exorcistWorker: Worker | null = null;
  private sessionId = 0;
  private snapshot: AppSnapshot;
  private readonly listeners = new Set<() => void>();
  private evalStart = 0;

  constructor() {
    const isolation = detectIsolation();
    this.host = new EngineHost(isolation);
    this.engine = createWorkbookEngine(this.doc.workbook, {
      sql: new SqlBridge(() => this.host.client('duckdb'), 'interactive'),
      py: new PyBridge(() => this.host.client('pyodide'), 'interactive'),
      clock: webClock,
      yieldControl,
    });
    this.snapshot = {
      isolation, gridReady: false,
      engines: { duckdb: this.host.status('duckdb'), pyodide: this.host.status('pyodide') },
      telemetry: this.host.telemetry(), lastEvalMs: null,
      values: new Map(), raws: new Map(SLICE_CELLS.map((c) => [c, this.rawOf(c)])),
      assertions: [], exorcist: { kind: 'idle' }, applied: null, generation: 0,
    };
    this.host.subscribe(() => this.set({ engines: { duckdb: this.host.status('duckdb'), pyodide: this.host.status('pyodide') }, telemetry: this.host.telemetry() }));
    this.engine.subscribe((e) => {
      if (e.kind === 'cellCommitted' || e.kind === 'cellPending') this.refreshValues();
      if (e.kind === 'generationComplete') this.set({ lastEvalMs: Math.round(performance.now() - this.evalStart) });
    });
    this.host.onPortReplaced((engine, portId, port, runningRequestId, cause, reason) => {
      const cmd: ExorcistCommand = { protocol: 1, kind: 'enginePortReplaced', engine, port, portId, runningRequestId, cause, reason };
      this.exorcistWorker?.postMessage(cmd, [port]);
    });
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

  private rawOf(c: CellKey): string {
    for (const s of this.engine?.definition().sheets ?? this.doc.workbook.sheets) for (const cell of s.cells) if (cell.key === c) return cell.raw;
    return '';
  }

  private refreshValues(): void {
    const values = new Map<CellKey, CellValue | 'pending'>(SLICE_CELLS.map((c) => [c, this.engine.getValue(c)]));
    const look = (c: CellKey): CellValue => {
      const v = this.engine.getValue(c);
      return v === 'pending' ? null : v;
    };
    const d1 = this.engine.getValue(k('D1'));
    const assertions: AssertionStatus[] = d1 === 'pending'
      ? []
      : this.doc.exorcist.assertions.map((a) => {
        const r = assertionHolds(a, look, null);
        return { id: a.id, label: LABELS[a.kind] ?? a.kind, ok: r.ok, detail: r.detail };
      });
    this.set({ values, assertions, raws: new Map(SLICE_CELLS.map((c) => [c, this.rawOf(c)])) });
  }

  /** First paint happens before any engine work (Spec 04 Req 4.2): the grid is ready, engines stay Lazy until needed. */
  async start(): Promise<void> {
    this.set({ gridReady: true });
    this.refreshValues();
    await new Promise((r) => setTimeout(r, 0));
    this.evalStart = performance.now();
    await this.engine.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 8 });
    const hash = location.hash;
    if (hash.startsWith('#replay=v1.')) await this.replayFromFragment(hash);
  }

  async edit(cell: CellKey, raw: string): Promise<void> {
    this.evalStart = performance.now();
    const g = this.engine.applyEdits([{ kind: 'setCell', key: cell, raw }]);
    this.set({ generation: g, applied: null });
    this.refreshValues();
    await this.engine.recalculate({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 8 });
  }

  private currentDocument(): SutureDocument {
    return { ...this.doc, workbook: this.engine.definition() };
  }

  private async ensureExorcist(): Promise<{ worker: Worker; ports: Pick<Extract<ExorcistCommand, { kind: 'start' }>, 'duckdbPort' | 'duckdbPortId' | 'pyodidePort' | 'pyodidePortId'> }> {
    if (this.exorcistWorker === null) {
      // Top-level worker created on the main thread (zero nested workers).
      const w = new Worker(new URL('../workers/exorcist.worker.ts', import.meta.url), { type: 'module', name: 'suture-exorcist' });
      w.addEventListener('message', (e: MessageEvent<unknown>) => this.onExorcistEvent(e.data));
      this.exorcistWorker = w;
    }
    const d = await this.host.connectClient('duckdb');
    const p = await this.host.connectClient('pyodide');
    return { worker: this.exorcistWorker, ports: { duckdbPort: d.port, duckdbPortId: d.portId, pyodidePort: p.port, pyodidePortId: p.portId } };
  }

  private exorcistStarted = 0;

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

  private async replayFromFragment(fragment: string): Promise<void> {
    const a = await fromReplayFragment(fragment, webCompressor);
    if ('error' in a) {
      this.set({ exorcist: { kind: 'error', message: a.error } });
      return;
    }
    // Sessions hash the engine's canonical (row-major) definition, so compare against the same canonical form.
    const expected = await workbookHash(this.currentDocument(), webHasher);
    if (a.workbookHash !== expected) {
      this.set({ exorcist: { kind: 'error', message: `replay link is for workbook ${a.workbookHash}, not the built-in slice (${expected})` } });
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

  /** Applies the shrunk counterexample as lossless setLiteral edits (Spec 04 Req 7.2) and recomputes A1 → B1 → D1 live. */
  async applyCounterexample(artifact: ReplayArtifact): Promise<void> {
    this.evalStart = performance.now();
    const g = this.engine.applyEdits(scenarioEdits(artifact.failingInputs));
    this.set({ generation: g, applied: artifact });
    this.refreshValues();
    await this.engine.recalculate({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 8 });
    this.refreshValues();
  }

  failingNow(): boolean {
    const v = this.engine.getValue(k('D1'));
    return v !== 'pending' && (isCellError(v) || this.snapshot.assertions.some((a) => !a.ok));
  }
}
