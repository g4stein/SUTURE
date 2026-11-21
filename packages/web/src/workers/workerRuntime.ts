import {
  isControlMessage, isWorkerRequest, PROTOCOL_VERSION, transferListOf,
  type HostEvent, type WorkerRequest, type WorkerResponse, type WorkerResult,
} from './protocol.ts';
import { diag } from './diag.ts'; // DIAG(temp)

const workerName = (): string => String((globalThis as { name?: unknown }).name ?? ''); // DIAG(temp)

/** Minimal dedicated-worker scope (the web package compiles against the DOM lib). */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'unhandledrejection', listener: (e: Event) => void): void;
}

export const scope = globalThis as unknown as WorkerScope;

export interface Job {
  readonly portId: number;
  readonly port: MessagePort | null; // null = the worker's own control channel
  readonly request: WorkerRequest;
  cancelled: boolean;
}

export type JobHandler = (job: Job, progress: (phase: 'download' | 'compile' | 'packages' | 'bootstrap', loaded: number, total: number | null) => void) => Promise<WorkerResult>;

/** Thrown by handlers for unrecoverable engine states (WASM traps, Pyodide fatal errors). */
export class FatalEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalEngineError';
  }
}

/**
 * Spec 02 §3.2: priority queue (interactive before background, FIFO within a priority). A job never starts inside an
 * onmessage handler; the next job starts on a fresh MessageChannel tick so already-delivered cancels are seen first.
 */
export function startWorkerRuntime(handle: JobHandler, onPeer?: (port: MessagePort) => void): void {
  const queue: Job[] = [];
  let running: Job | null = null;
  const tick = new MessageChannel();
  let scheduled = false;

  const send = (job: Job, msg: WorkerResponse): void => {
    const transfer = transferListOf(msg);
    if (job.port === null) scope.postMessage(msg, transfer);
    else job.port.postMessage(msg, transfer);
  };
  const host = (e: HostEvent): void => scope.postMessage(e);

  const schedule = (): void => {
    if (scheduled || running !== null) return;
    scheduled = true;
    tick.port2.postMessage(0);
  };

  tick.port1.onmessage = () => {
    scheduled = false;
    if (running !== null) return;
    const idx = queue.findIndex((j) => j.request.priority === 'interactive');
    const job = queue.splice(idx >= 0 ? idx : 0, 1)[0];
    if (job === undefined) return;
    running = job;
    diag('worker.jobStarted', { w: workerName(), portId: job.portId, requestId: job.request.requestId, kind: job.request.kind });
    host({ protocol: PROTOCOL_VERSION, kind: 'jobStarted', portId: job.portId, requestId: job.request.requestId });
    send(job, { protocol: PROTOCOL_VERSION, kind: 'started', requestId: job.request.requestId });
    handle(job, (phase, loaded, total) => send(job, { protocol: PROTOCOL_VERSION, kind: 'progress', requestId: job.request.requestId, phase, loadedBytes: loaded, totalBytes: total }))
      .then((result) => {
        send(job, { protocol: PROTOCOL_VERSION, kind: 'result', requestId: job.request.requestId, result });
        diag('worker.responsePosted', { w: workerName(), requestId: job.request.requestId, kind: result.kind });
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        diag('worker.handlerThrew', { w: workerName(), requestId: job.request.requestId, fatal: e instanceof FatalEngineError || e instanceof WebAssembly.RuntimeError || e instanceof RangeError, message: message.slice(0, 600) });
        if (e instanceof FatalEngineError || e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
          host({ protocol: PROTOCOL_VERSION, kind: 'fatal', reason: message });
          return;
        }
        send(job, { protocol: PROTOCOL_VERSION, kind: 'result', requestId: job.request.requestId, result: { kind: 'failed', message } });
      })
      .finally(() => {
        host({ protocol: PROTOCOL_VERSION, kind: 'jobFinished', portId: job.portId, requestId: job.request.requestId });
        running = null;
        schedule();
      });
  };

  const accept = (data: unknown, portId: number, port: MessagePort | null): void => {
    if (isControlMessage(data)) {
      if (data.kind === 'cancel') {
        const i = queue.findIndex((j) => j.portId === portId && j.request.requestId === data.requestId);
        if (i >= 0) {
          const [job] = queue.splice(i, 1);
          if (job !== undefined) send(job, { protocol: PROTOCOL_VERSION, kind: 'result', requestId: job.request.requestId, result: { kind: 'cancelled' } });
        }
        return;
      }
      if (data.role === 'peer') {
        onPeer?.(data.port);
        return;
      }
      const p = data.port;
      p.onmessage = (ev: MessageEvent<unknown>) => accept(ev.data, data.portId, p);
      p.onmessageerror = () => p.postMessage({ protocol: PROTOCOL_VERSION, kind: 'protocolError', requestId: null, reason: 'messageerror: message could not be deserialized' });
      return;
    }
    if (!isWorkerRequest(data)) {
      const requestId = typeof data === 'object' && data !== null && typeof (data as { requestId?: unknown }).requestId === 'number' ? (data as { requestId: number }).requestId : null;
      const msg: WorkerResponse = { protocol: PROTOCOL_VERSION, kind: 'protocolError', requestId, reason: 'message failed protocol validation' };
      if (port === null) scope.postMessage(msg);
      else port.postMessage(msg);
      return;
    }
    queue.push({ portId, port, request: data, cancelled: false });
    diag('worker.jobQueued', { w: workerName(), portId, requestId: data.requestId, kind: data.kind, queueLength: queue.length, busy: running !== null });
    schedule();
  };

  scope.addEventListener('message', (e) => accept(e.data, 0, null));
  scope.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    host({ protocol: PROTOCOL_VERSION, kind: 'fatal', reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

/** Ticket shared by clients and workers for control-buffer cancellation (Spec 02 §6.2). */
export function ticketOf(portId: number, requestId: number): number {
  return ((portId * 2 ** 20) + (requestId % 2 ** 20)) % 2 ** 31;
}
