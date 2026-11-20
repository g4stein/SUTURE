import { isHostEvent, PROTOCOL_VERSION, type ControlMessage, type EngineName, type EngineStatus } from './protocol.ts';
import { DEGRADED_REASON, isIsolated, type IsolationInfo } from './isolation.ts';
import { PortClient, type RespawnCause } from './portClient.ts';

export interface Telemetry {
  readonly duckdbInitMs: number | null;
  readonly pyodideInitMs: number | null;
  readonly validator: 'ast' | 'lexical' | null;
  readonly duckdbBundle: 'eh' | 'mvp' | null;
  readonly duckdbVersion: string | null;
  readonly pyodideVersion: string | null;
  readonly numpyVersion: string | null;
}

export type PortReplaced = (engine: EngineName, portId: number, port: MessagePort, runningRequestId: number | null, cause: RespawnCause, reason: string) => void;

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
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

/**
 * Owns every engine Worker (Spec 02 §7). All workers are top-level dedicated workers created here on the main thread;
 * no worker creates another worker (steering architecture-and-isolation.md §2).
 */
export class EngineHost {
  private readonly slots: Record<EngineName, Slot>;
  private readonly listeners = new Set<() => void>();
  private readonly portListeners = new Set<PortReplaced>();
  private readonly control: Record<EngineName, SharedArrayBuffer | null>;
  private nextPortId = 1;
  private telemetryState: Telemetry = {
    duckdbInitMs: null, pyodideInitMs: null, validator: null, duckdbBundle: null, duckdbVersion: null, pyodideVersion: null, numpyVersion: null,
  };

  constructor(readonly isolation: IsolationInfo) {
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPortReplaced(listener: PortReplaced): () => void {
    this.portListeners.add(listener);
    return () => this.portListeners.delete(listener);
  }

  private setStatus(engine: EngineName, patch: Partial<EngineStatus>): void {
    const s = this.slots[engine];
    s.status = { ...s.status, ...patch, crashCount: s.crashes.length };
    for (const l of this.listeners) l();
  }

  private patchTelemetry(patch: Partial<Telemetry>): void {
    this.telemetryState = { ...this.telemetryState, ...patch };
    for (const l of this.listeners) l();
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
    const ch = new MessageChannel();
    const msg: ControlMessage = { protocol: PROTOCOL_VERSION, kind: 'attachPort', portId, role: 'client', port: ch.port1 };
    w.postMessage(msg, [ch.port1]);
    return ch.port2;
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

  private createWorker(engine: EngineName): Worker {
    return engine === 'duckdb'
      ? new Worker(new URL('./duckdb.worker.ts', import.meta.url), { type: 'module', name: 'suture-duckdb' })
      : new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module', name: 'suture-pyodide' });
  }

  private async spawn(engine: EngineName, replacing: { readonly running: Map<number, number>; readonly cause: RespawnCause; readonly reason: string } | null): Promise<PortClient> {
    const s = this.slots[engine];
    this.setStatus(engine, { state: 'loading', progress: null, reason: null });
    const worker = this.createWorker(engine);
    s.worker = worker;
    s.running = new Map();
    worker.addEventListener('message', (e: MessageEvent<unknown>) => {
      const m = e.data;
      if (!isHostEvent(m)) return;
      if (m.kind === 'jobStarted') s.running.set(m.portId, m.requestId);
      else if (m.kind === 'jobFinished') { if (s.running.get(m.portId) === m.requestId) s.running.delete(m.portId); }
      else this.crash(engine, m.reason);
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      e.preventDefault();
      this.crash(engine, e.message || 'uncaught error in worker');
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
    if (replacing !== null) {
      for (const portId of s.external) {
        const np = this.attach(engine, portId);
        for (const l of this.portListeners) l(engine, portId, np, replacing.running.get(portId) ?? null, replacing.cause, replacing.reason);
      }
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
      this.setStatus(engine, { state: 'failed', progress: null, reason: init.kind === 'failed' ? init.message : `initialization returned ${init.kind}` });
      throw new Error(`${engine} failed to initialize`);
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
}
