import type { DatasetMeta, TableRef } from '@suture/core';
import {
  DEGRADED_REASON, isHostEvent, isIsolated, PROTOCOL_VERSION,
  type ControlMessage, type EngineName, type EngineStatus, type IsolationInfo, type RegisterDatasetPayload, type XlsxIngestResult,
} from '@suture/runtime/bridge';
import { PortClient, type RespawnCause } from './portClient.ts';

export interface Telemetry {
  /** Cold boot per engine: worker start → engine ready (WASM download + compile + init). */
  readonly duckdbInitMs: number | null;
  readonly pyodideInitMs: number | null;
  readonly validator: 'ast' | 'lexical' | null;
  readonly duckdbBundle: 'eh' | 'mvp' | null;
  readonly duckdbVersion: string | null;
  readonly pyodideVersion: string | null;
  readonly numpyVersion: string | null;
  readonly respawns: Readonly<Record<EngineName, number>>;
}

export type PortReplaced = (engine: EngineName, portId: number, port: MessagePort, runningRequestId: number | null, cause: RespawnCause, reason: string) => void;

export type WorkerKindName = EngineName | 'ingest';
export type WorkerFactory = (kind: WorkerKindName) => Worker;

/** Production workers. Every one is a top-level dedicated worker (zero nested workers). */
export const defaultWorkers: WorkerFactory = (kind) => {
  switch (kind) {
    case 'duckdb': return new Worker(new URL('./duckdb.worker.ts', import.meta.url), { type: 'module', name: 'suture-duckdb' });
    case 'pyodide': return new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module', name: 'suture-pyodide' });
    case 'ingest': return new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module', name: 'suture-ingest' });
  }
};

interface Slot {
  worker: Worker | null;
  main: PortClient | null;
  ready: Promise<PortClient> | null;
  status: EngineStatus;
  /** portId → requestId currently running on that port (from jobStarted/jobFinished host events). */
  running: Map<number, number>;
  external: Set<number>;
  crashes: number[];
}

const INIT_DEADLINE_MS = 120_000;
const INGEST_DEADLINE_MS = 120_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

export interface RegisteredDataset {
  readonly meta: DatasetMeta;
  readonly preview: TableRef;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Owns every Worker (Spec 02 §7). All workers are top-level dedicated workers created here on the main thread; no worker
 * creates another worker (steering architecture-and-isolation.md §2).
 */
export class EngineHost {
  private readonly slots: Record<EngineName, Slot>;
  private readonly listeners = new Set<() => void>();
  private readonly portListeners = new Set<PortReplaced>();
  private readonly control: Record<EngineName, SharedArrayBuffer | null>;
  /** Source bytes of every registered dataset, retained so a respawned DuckDB worker can be restored (Req 5.7, 9.3). */
  private readonly retained: RegisterDatasetPayload[] = [];
  private ingest: { worker: Worker; client: PortClient } | null = null;
  private nextPortId = 1;
  private telemetryState: Telemetry = {
    duckdbInitMs: null, pyodideInitMs: null, validator: null, duckdbBundle: null, duckdbVersion: null, pyodideVersion: null, numpyVersion: null,
    respawns: { duckdb: 0, pyodide: 0 },
  };

  constructor(readonly isolation: IsolationInfo, private readonly workers: WorkerFactory = defaultWorkers) {
    const slot = (engine: EngineName): Slot => ({
      worker: null, main: null, ready: null, running: new Map(), external: new Set(), crashes: [],
      status: { engine, state: 'notLoaded', progress: null, reason: null, crashCount: 0 },
    });
    this.slots = { duckdb: slot('duckdb'), pyodide: slot('pyodide') };
    const sab = (): SharedArrayBuffer | null => (isIsolated(isolation) ? new SharedArrayBuffer(8) : null);
    this.control = { duckdb: sab(), pyodide: sab() };
  }

  status(engine: EngineName): EngineStatus {
    return this.slots[engine].status;
  }

  telemetry(): Telemetry {
    return this.telemetryState;
  }

  controlBuffer(engine: EngineName): SharedArrayBuffer | null {
    return this.control[engine];
  }

  datasets(): ReadonlyArray<string> {
    return this.retained.map((d) => d.name);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPortReplaced(listener: PortReplaced): () => void {
    this.portListeners.add(listener);
    return () => this.portListeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private setStatus(engine: EngineName, patch: Partial<EngineStatus>): void {
    const s = this.slots[engine];
    s.status = { ...s.status, ...patch, crashCount: s.crashes.length };
    this.notify();
  }

  private patchTelemetry(patch: Partial<Telemetry>): void {
    this.telemetryState = { ...this.telemetryState, ...patch };
    this.notify();
  }

  /** The main thread's own client; starts the engine on first use (lazy, Spec 02 Req 1.4). */
  client(engine: EngineName): Promise<PortClient> {
    const s = this.slots[engine];
    if (s.ready === null) s.ready = this.spawn(engine, null);
    return s.ready;
  }

  /** A port for another client (the Exorcist worker). */
  async connectClient(engine: EngineName): Promise<{ readonly portId: number; readonly port: MessagePort }> {
    await this.client(engine);
    const s = this.slots[engine];
    const portId = this.nextPortId++;
    s.external.add(portId);
    return { portId, port: this.attach(engine, portId) };
  }

  private attach(engine: EngineName, portId: number): MessagePort {
    const w = this.slots[engine].worker;
    if (w === null) throw new Error(`${engine} worker is not running`);
    return attachTo(w, portId);
  }

  private wirePeers(): void {
    const d = this.slots.duckdb.worker;
    const p = this.slots.pyodide.worker;
    if (d === null || p === null) return;
    const ch = new MessageChannel();
    const a: ControlMessage = { protocol: PROTOCOL_VERSION, kind: 'attachPort', portId: 0, role: 'peer', port: ch.port1 };
    const b: ControlMessage = { protocol: PROTOCOL_VERSION, kind: 'attachPort', portId: 0, role: 'peer', port: ch.port2 };
    d.postMessage(a, [ch.port1]);
    p.postMessage(b, [ch.port2]);
  }

  private async spawn(engine: EngineName, replacing: { readonly running: Map<number, number>; readonly cause: RespawnCause; readonly reason: string } | null): Promise<PortClient> {
    const s = this.slots[engine];
    this.setStatus(engine, { state: 'loading', progress: null, reason: null });
    // A signal written for the job that forced this respawn must not reach the replacement: Pyodide would raise
    // KeyboardInterrupt inside its own initialization (found by the e2e escalation test).
    const ctl = this.control[engine];
    if (ctl !== null) new Int32Array(ctl).fill(0);
    const worker = this.workers(engine);
    s.worker = worker;
    s.running = new Map();
    worker.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (s.worker !== worker) return;
      const m = e.data;
      if (!isHostEvent(m)) return;
      if (m.kind === 'jobStarted') s.running.set(m.portId, m.requestId);
      else if (m.kind === 'jobFinished') { if (s.running.get(m.portId) === m.requestId) s.running.delete(m.portId); }
      else this.crash(engine, m.reason);
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      e.preventDefault();
      if (s.worker === worker) this.crash(engine, e.message || 'uncaught error in worker');
    });
    worker.addEventListener('messageerror', () => undefined); // handled as protocolError on client ports (Req 9.7)

    const mainPortId = 0;
    const port = this.attach(engine, mainPortId);
    const opts = {
      portId: mainPortId, engine, isolation: this.isolation,
      control: this.control[engine] === null ? null : new Int32Array(this.control[engine] as SharedArrayBuffer),
      onRespawnNeeded: (requestId: number, cause: 'deadline' | 'abort') => this.requestRespawn(engine, mainPortId, requestId, cause),
      onProgress: (loaded: number, total: number | null) => this.setStatus(engine, { progress: { loadedBytes: loaded, totalBytes: total } }),
    };
    let main = s.main;
    if (main === null || replacing === null) {
      main = new PortClient(port, opts);
      s.main = main;
    } else {
      main.replacePort(port, replacing.running.get(mainPortId) ?? null, replacing.cause, replacing.reason);
    }
    this.wirePeers();

    const t0 = performance.now();
    const init = engine === 'duckdb'
      ? await main.request('duckdb.init', { isolation: this.isolation, cancelBuffer: this.control.duckdb }, { priority: 'interactive', deadlineMs: INIT_DEADLINE_MS, signal: null, generation: null })
      : await main.request('py.init', { isolation: this.isolation, interruptBuffer: this.control.pyodide }, { priority: 'interactive', deadlineMs: INIT_DEADLINE_MS, signal: null, generation: null });
    const ms = Math.round(performance.now() - t0);
    if (init.kind === 'duckdb.ready') this.patchTelemetry({ duckdbInitMs: ms, validator: init.validator, duckdbBundle: init.bundle, duckdbVersion: init.duckdbVersion });
    else if (init.kind === 'py.ready') this.patchTelemetry({ pyodideInitMs: ms, pyodideVersion: init.pyodideVersion, numpyVersion: init.numpyVersion });
    else {
      const reason = init.kind === 'failed' ? init.message : `initialization returned ${init.kind}`;
      this.setStatus(engine, { state: 'failed', progress: null, reason });
      main.failAll(`${engine} failed to initialize: ${reason}`); // held requests resolve as #SQL!/#PY!, never hang
      s.ready = null;
      throw new Error(`${engine} failed to initialize`);
    }
    if (replacing !== null) {
      // Restore engine state before any held request runs (Spec 02 Req 9.3): datasets in their original order.
      if (engine === 'duckdb') {
        for (const d of this.retained) {
          await main.request('duckdb.registerDataset', { ...d, bytes: d.bytes.slice() }, { priority: 'interactive', deadlineMs: INIT_DEADLINE_MS, signal: null, generation: null });
        }
      }
      main.resume();
      for (const portId of s.external) {
        const np = this.attach(engine, portId);
        for (const l of this.portListeners) l(engine, portId, np, replacing.running.get(portId) ?? null, replacing.cause, replacing.reason);
      }
      this.patchTelemetry({ respawns: { ...this.telemetryState.respawns, [engine]: this.telemetryState.respawns[engine] + 1 } });
    }
    const isolated = isIsolated(this.isolation);
    this.setStatus(engine, { state: isolated ? 'ready' : 'degraded', progress: null, reason: isolated ? null : DEGRADED_REASON });
    return main;
  }

  /** Timeout without isolation, or a cooperative cancel that did not settle within 1,000 ms. */
  requestRespawn(engine: EngineName, portId: number, requestId: number, cause: 'deadline' | 'abort'): void {
    const s = this.slots[engine];
    if (s.running.get(portId) !== requestId) return; // already finished
    this.restart(engine, cause, cause === 'deadline' ? 'deadline exceeded' : 'cancel did not settle');
  }

  private crash(engine: EngineName, reason: string): void {
    const s = this.slots[engine];
    const now = performance.now();
    s.crashes = [...s.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (s.crashes.length >= MAX_CRASHES) {
      s.worker?.terminate();
      s.worker = null;
      s.main?.failAll(reason);
      s.ready = null;
      this.setStatus(engine, { state: 'failed', reason: `crashed ${s.crashes.length} times in 60 s: ${reason}` });
      return;
    }
    this.restart(engine, 'crash', reason);
  }

  private restart(engine: EngineName, cause: RespawnCause, reason: string): void {
    const s = this.slots[engine];
    const running = new Map(s.running);
    s.worker?.terminate();
    s.worker = null;
    s.ready = this.spawn(engine, { running, cause, reason });
    s.ready.catch(() => undefined);
  }

  async retry(engine: EngineName): Promise<void> {
    const s = this.slots[engine];
    s.crashes = [];
    s.main = null;
    s.ready = this.spawn(engine, null);
    await s.ready;
  }

  /** Registers an uploaded file (or an Arrow table from a spreadsheet import) as a DuckDB dataset. Bytes never leave the machine. */
  async registerDataset(file: { readonly name: string; readonly bytes: Uint8Array; readonly sourceFormat: 'csv' | 'parquet' | 'xlsx'; readonly encoding: 'csv' | 'parquet' | 'arrow' }): Promise<RegisteredDataset | { readonly error: string }> {
    const payload: RegisterDatasetPayload = { name: file.name, sourceFormat: file.sourceFormat, encoding: file.encoding, bytes: file.bytes.slice(), sha256: await sha256Hex(file.bytes) };
    const c = await this.client('duckdb');
    const r = await c.request('duckdb.registerDataset', { ...payload, bytes: payload.bytes.slice() }, { priority: 'interactive', deadlineMs: INGEST_DEADLINE_MS, signal: null, generation: null });
    if (r.kind !== 'dataset') return { error: r.kind === 'failed' ? r.message : `registration returned ${r.kind}` };
    const i = this.retained.findIndex((d) => d.name === payload.name);
    if (i >= 0) this.retained.splice(i, 1);
    this.retained.push(payload);
    this.notify();
    return { meta: r.meta, preview: r.preview };
  }

  /** Parses a spreadsheet file in the lazily created ingest worker (the only chunk that contains exceljs). */
  async ingestXlsx(fileName: string, bytes: Uint8Array): Promise<XlsxIngestResult | { readonly error: string }> {
    if (this.ingest === null) {
      const worker = this.workers('ingest');
      const client = new PortClient(attachTo(worker, 0), { portId: 0, engine: 'duckdb', isolation: this.isolation, control: null, onRespawnNeeded: () => undefined });
      worker.addEventListener('error', (e: ErrorEvent) => {
        e.preventDefault();
        client.failAll(e.message || 'ingest worker crashed');
        worker.terminate();
        if (this.ingest?.worker === worker) this.ingest = null;
      });
      this.ingest = { worker, client };
    }
    const copy = bytes.slice();
    const r = await this.ingest.client.request('ingest.xlsx', { fileName, bytes: copy }, { priority: 'interactive', deadlineMs: INGEST_DEADLINE_MS, signal: null, generation: null, transfer: [copy.buffer] }).catch((e: unknown) => ({ kind: 'failed' as const, message: e instanceof Error ? e.message : String(e) }));
    if (r.kind === 'xlsx') return r.workbook;
    return { error: r.kind === 'failed' ? r.message : `ingest returned ${r.kind}` };
  }
}

function attachTo(w: Worker, portId: number): MessagePort {
  const ch = new MessageChannel();
  const msg: ControlMessage = { protocol: PROTOCOL_VERSION, kind: 'attachPort', portId, role: 'client', port: ch.port1 };
  w.postMessage(msg, [ch.port1]);
  return ch.port2;
}
