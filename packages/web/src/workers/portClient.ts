import {
  DeadlineExceeded, EngineCrashed, isIsolated, isWorkerResponse, PROTOCOL_VERSION, ticketOf,
  type ControlMessage, type EngineClient, type EngineName, type IsolationInfo, type PayloadOf, type RequestKind, type RequestOptions,
  type WorkerRequest, type WorkerResult,
} from '@suture/runtime/bridge';

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

const ESCALATE_MS = 1000;
/**
 * Re-assert period for a control-buffer signal (Spec 02 §6.2). Pyodide consumes the interrupt byte with a plain read
 * followed by an unconditional `buffer[0] = 0`, many times per second while Python runs. A single store that lands
 * between that read and that write is erased. In a Node stress test, 24 % of single writes during `while True: pass`
 * were lost. Re-asserting every 25 ms lost none in 300 trials, and the slowest one settled in 130 ms.
 */
const REASSERT_MS = 25;

interface Escalation {
  readonly timer: ReturnType<typeof setTimeout>;    // ESCALATE_MS: respawn if the worker has not settled
  readonly reassert: ReturnType<typeof setInterval>; // REASSERT_MS: rewrite a signal that was consumed or erased
}

interface Pending {
  readonly message: WorkerRequest;
  readonly transfer: Transferable[];
  readonly deadlineMs: number;
  readonly resolve: (r: WorkerResult) => void;
  readonly reject: (e: Error) => void;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Browser transport for the shared `EngineClient` contract: one MessagePort to a dedicated engine worker. */
export class PortClient implements EngineClient {
  private port: MessagePort;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Running requests that were signalled to stop; if the worker does not settle within 1 s, escalate. */
  private readonly escalations = new Map<number, Escalation>();
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
    if (m.kind === 'result') this.endEscalation(m.requestId);
    const p = this.pending.get(m.requestId);
    if (p === undefined) return;
    if (m.kind === 'started') {
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

  private endEscalation(id: number): void {
    const esc = this.escalations.get(id);
    if (esc === undefined) return;
    clearTimeout(esc.timer);
    clearInterval(esc.reassert);
    this.escalations.delete(id);
  }

  private signalRunning(id: number, cause: 'deadline' | 'abort'): void {
    const ctl = this.opts.control;
    if (ctl !== null && isIsolated(this.opts.isolation)) {
      const ticket = ticketOf(this.opts.portId, id);
      const signal = this.opts.engine === 'pyodide' ? 2 : 1; // 2 = SIGINT for Pyodide
      Atomics.store(ctl, 1, ticket);
      Atomics.store(ctl, 0, signal);
      // Until the worker settles, rewrite the signal whenever the byte reads 0 (consumed or erased, see REASSERT_MS). The
      // ticket is rewritten first, so a worker that sees the signal also sees this request's ticket. A re-assert that
      // arrives after the job finished hits the next job with a stale ticket, which the worker's ticket check absorbs
      // (Spec 02 §6.2): Pyodide clears it and re-runs that job deterministically, DuckDB clears it and continues.
      const reassert = setInterval(() => {
        if (Atomics.load(ctl, 0) !== 0) return;
        Atomics.store(ctl, 1, ticket);
        Atomics.compareExchange(ctl, 0, 0, signal);
      }, REASSERT_MS);
      const timer = setTimeout(() => {
        if (!this.escalations.has(id)) return;
        this.endEscalation(id);
        this.opts.onRespawnNeeded(id, cause);
      }, ESCALATE_MS);
      this.escalations.set(id, { timer, reassert });
    } else if (cause === 'deadline') {
      this.opts.onRespawnNeeded(id, cause);
    }
  }

  private onDeadline(id: number): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
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
    for (const id of [...this.escalations.keys()]) this.endEscalation(id);
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
    for (const id of [...this.escalations.keys()]) this.endEscalation(id);
    this.held = [];
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new EngineCrashed(reason));
    }
  }
}
