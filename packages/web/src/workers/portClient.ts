import type { CancellationToken } from '@suture/core';
import {
  isWorkerResponse, PROTOCOL_VERSION,
  type ControlMessage, type EngineName, type PayloadOf, type Priority, type RequestKind, type WorkerRequest, type WorkerResult,
} from './protocol.ts';
import { isIsolated, type IsolationInfo } from './isolation.ts';
import { ticketOf } from './workerRuntime.ts';
import { diag } from './diag.ts'; // DIAG(temp)

export type RespawnCause = 'deadline' | 'abort' | 'crash';

export interface PortClientOptions {
  readonly portId: number;
  readonly engine: EngineName;
  readonly isolation: IsolationInfo;
  /** isolated only: Pyodide interrupt buffer or DuckDB cancel buffer, [0] signal, [1] ticket */
  readonly control: Int32Array | null;
  /** deadline when not isolated, or a cooperative cancel not settled within 1,000 ms */
  readonly onRespawnNeeded: (requestId: number, cause: 'deadline' | 'abort') => void;
  readonly onProgress?: (loadedBytes: number, totalBytes: number | null) => void;
}

/** Thrown into a pending request when its deadline passes; bridges turn it into #TIMEOUT!. */
export class DeadlineExceeded extends Error {
  constructor(readonly afterMs: number) {
    super(`deadline of ${afterMs} ms exceeded`);
    this.name = 'DeadlineExceeded';
  }
}

export class EngineCrashed extends Error {
  constructor(readonly reason: string) {
    super(`engine crashed: ${reason}`);
    this.name = 'EngineCrashed';
  }
}

const ESCALATE_MS = 1000;

interface Pending {
  readonly message: WorkerRequest;
  readonly transfer: Transferable[];
  readonly deadlineMs: number;
  readonly resolve: (r: WorkerResult) => void;
  readonly reject: (e: Error) => void;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RequestOptions {
  readonly priority: Priority;
  readonly deadlineMs: number;
  readonly signal: AbortSignal | null;
  readonly generation: number | null;
  readonly transfer?: Transferable[];
}

/** What the core-port bridges need from an engine: PortClient (browser workers) or a direct in-process client (Node hosts). */
export interface EngineClient {
  request<K extends RequestKind>(kind: K, payload: PayloadOf<K>, opts: RequestOptions): Promise<WorkerResult>;
}

export class PortClient implements EngineClient {
  private port: MessagePort;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Running requests that were signalled to stop; if the worker does not settle within 1 s, escalate. */
  private readonly escalations = new Map<number, ReturnType<typeof setTimeout>>();
  /** Requests sent to a crashed worker but never started; re-sent by resume() once the replacement is initialized. */
  private held: number[] = [];

  constructor(port: MessagePort, private opts: PortClientOptions) {
    this.port = port;
    this.listen();
  }

  get portId(): number {
    return this.opts.portId;
  }

  private listen(): void {
    this.port.onmessage = (e: MessageEvent<unknown>) => this.onMessage(e.data);
  }

  private onMessage(m: unknown): void {
    if (!isWorkerResponse(m)) return;
    if (m.kind === 'protocolError') {
      if (m.requestId !== null) this.settle(m.requestId, { kind: 'failed', message: `protocol error: ${m.reason}` });
      return;
    }
    if (m.kind === 'result') {
      const esc = this.escalations.get(m.requestId);
      diag('client.resultReceived', { engine: this.opts.engine, requestId: m.requestId, kind: m.result.kind, escalationPending: esc !== undefined, pending: this.pending.has(m.requestId) });
      if (esc !== undefined) {
        clearTimeout(esc);
        this.escalations.delete(m.requestId);
      }
    }
    const p = this.pending.get(m.requestId);
    if (p === undefined) return;
    if (m.kind === 'started') {
      diag('client.startedReceived', { engine: this.opts.engine, requestId: m.requestId, deadlineMs: p.deadlineMs });
      p.started = true;
      if (p.deadlineMs > 0) p.timer = setTimeout(() => this.onDeadline(m.requestId), p.deadlineMs);
      return;
    }
    if (m.kind === 'progress') {
      this.opts.onProgress?.(m.loadedBytes, m.totalBytes);
      return;
    }
    this.settle(m.requestId, m.result);
  }

  private settle(id: number, r: WorkerResult): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    if (p.timer !== null) clearTimeout(p.timer);
    p.resolve(r);
  }

  private signalRunning(id: number, cause: 'deadline' | 'abort'): void {
    const ctl = this.opts.control;
    if (ctl !== null && isIsolated(this.opts.isolation)) {
      Atomics.store(ctl, 1, ticketOf(this.opts.portId, id));
      Atomics.store(ctl, 0, this.opts.engine === 'pyodide' ? 2 : 1); // 2 = SIGINT for Pyodide
      diag('client.interruptByteWritten', { engine: this.opts.engine, requestId: id, cause, ticket: ticketOf(this.opts.portId, id), ctl0: Atomics.load(ctl, 0), ctl1: Atomics.load(ctl, 1), shared: ctl.buffer instanceof SharedArrayBuffer, coi: globalThis.crossOriginIsolated === true });
      this.escalations.set(id, setTimeout(() => {
        diag('client.escalationTimerFired', { engine: this.opts.engine, requestId: id, stillEscalating: this.escalations.has(id), ctl0: Atomics.load(ctl, 0) });
        if (this.escalations.delete(id)) this.opts.onRespawnNeeded(id, cause);
      }, ESCALATE_MS));
    } else if (cause === 'deadline') {
      this.opts.onRespawnNeeded(id, cause);
    }
  }

  private onDeadline(id: number): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    diag('client.deadlineTimerFired', { engine: this.opts.engine, requestId: id, deadlineMs: p.deadlineMs });
    // The cell becomes #TIMEOUT! now; whatever the worker returns later is discarded.
    this.pending.delete(id);
    this.signalRunning(id, 'deadline');
    p.reject(new DeadlineExceeded(p.deadlineMs));
  }

  request<K extends RequestKind>(kind: K, payload: PayloadOf<K>, opts: RequestOptions): Promise<WorkerResult> {
    const requestId = this.nextId++;
    const message = { protocol: PROTOCOL_VERSION, requestId, generation: opts.generation, kind, priority: opts.priority, deadlineMs: opts.deadlineMs, payload } as WorkerRequest;
    return new Promise<WorkerResult>((resolve, reject) => {
      const p: Pending = { message, transfer: opts.transfer ?? [], deadlineMs: opts.deadlineMs, resolve, reject, started: false, timer: null };
      this.pending.set(requestId, p);
      if (opts.signal !== null) {
        const onAbort = (): void => {
          const cur = this.pending.get(requestId);
          if (cur === undefined) return;
          this.pending.delete(requestId);
          if (cur.timer !== null) clearTimeout(cur.timer);
          if (cur.started) this.signalRunning(requestId, 'abort');
          else {
            const cancel: ControlMessage = { protocol: PROTOCOL_VERSION, kind: 'cancel', requestId };
            this.port.postMessage(cancel);
          }
          // Spec 02 §6.2: abort resolves as cancelled at once; a late result is discarded.
          resolve({ kind: 'cancelled' });
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.port.postMessage(message, p.transfer);
      diag('client.requestSent', { engine: this.opts.engine, portId: this.opts.portId, requestId, kind, deadlineMs: opts.deadlineMs });
    });
  }

  /**
   * Crash recovery (Spec 02 §7): resolve the running request by cause and hold the never-started ones. The host calls
   * resume() after the replacement worker is initialized and its state restored, so held requests never overtake init.
   */
  replacePort(port: MessagePort, runningRequestId: number | null, cause: RespawnCause, reason: string): void {
    this.port.onmessage = null;
    this.port = port;
    this.listen();
    for (const t of this.escalations.values()) clearTimeout(t);
    this.escalations.clear();
    const entries = [...this.pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [id, p] of entries) {
      if (p.timer !== null) clearTimeout(p.timer);
      if (id === runningRequestId || p.started) {
        this.pending.delete(id);
        if (cause === 'deadline') p.reject(new DeadlineExceeded(p.deadlineMs));
        else if (cause === 'abort') p.resolve({ kind: 'cancelled' });
        else p.reject(new EngineCrashed(reason));
        continue;
      }
      if (p.transfer.length > 0) {
        // Its bytes were transferred to the dead worker and are detached; it cannot be re-sent as-is.
        this.pending.delete(id);
        p.reject(new EngineCrashed(`${reason} (request bytes were held by the crashed worker)`));
        continue;
      }
      p.started = false;
      p.timer = null;
      this.held.push(id);
    }
  }

  /** Re-sends held requests, in their original order. */
  resume(): void {
    const ids = this.held;
    this.held = [];
    for (const id of ids) {
      const p = this.pending.get(id);
      if (p !== undefined) this.port.postMessage(p.message);
    }
  }

  failAll(reason: string): void {
    this.held = [];
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new EngineCrashed(reason));
    }
  }
}

export function signalFromToken(token: CancellationToken): AbortSignal {
  const ctl = new AbortController();
  if (token.cancelled) ctl.abort();
  else token.onCancel(() => ctl.abort());
  return ctl.signal;
}

export function tokenFromSignal(signal: AbortSignal): CancellationToken {
  return {
    get cancelled() {
      return signal.aborted;
    },
    onCancel(listener) {
      if (signal.aborted) {
        listener();
        return () => undefined;
      }
      signal.addEventListener('abort', listener, { once: true });
      return () => signal.removeEventListener('abort', listener);
    },
  };
}
