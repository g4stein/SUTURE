import type { CancellationToken } from '@suture/core';
import type { PayloadOf, Priority, RequestKind, WorkerResult } from './protocol.ts';

/** Thrown into a pending request when its deadline passes; bridges turn it into #TIMEOUT!. */
export class DeadlineExceeded extends Error {
  readonly afterMs: number;
  constructor(afterMs: number) {
    super(`deadline of ${afterMs} ms exceeded`);
    this.name = 'DeadlineExceeded';
    this.afterMs = afterMs;
  }
}

export class EngineCrashed extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`engine crashed: ${reason}`);
    this.name = 'EngineCrashed';
    this.reason = reason;
  }
}

export interface RequestOptions {
  readonly priority: Priority;
  readonly deadlineMs: number;
  readonly signal: AbortSignal | null;
  readonly generation: number | null;
  readonly transfer?: Transferable[];
}

/** What the core-port bridges need from an engine: PortClient (browser workers) or DirectClient (in-process Node hosts). */
export interface EngineClient {
  request<K extends RequestKind>(kind: K, payload: PayloadOf<K>, opts: RequestOptions): Promise<WorkerResult>;
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
