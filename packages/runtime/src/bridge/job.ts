import type { WorkerRequest, WorkerResult } from './protocol.ts';

/**
 * One engine request as a handler sees it (Spec 02 §3.2). Browser workers build jobs from MessagePort messages
 * (`packages/web` `startWorkerRuntime`); Node hosts build them in-process (`@suture/runtime/node` `DirectClient`).
 */
export interface Job {
  readonly portId: number;
  readonly port: MessagePort | null; // null = the worker's own control channel (or an in-process Node client)
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

/** Ticket shared by clients and workers for control-buffer cancellation (Spec 02 §6.2). */
export function ticketOf(portId: number, requestId: number): number {
  return ((portId * 2 ** 20) + (requestId % 2 ** 20)) % 2 ** 31;
}
