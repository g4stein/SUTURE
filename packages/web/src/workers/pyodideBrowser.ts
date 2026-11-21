import { loadPyodide, version as pyodideVersion } from 'pyodide';
import bridgeSource from '@suture/runtime/python/suture_bridge.py?raw';
import { createPyodideHandler } from '@suture/runtime/engines';
import { isPeerMessage, PROTOCOL_VERSION, type PeerMessage, type ResultId } from '@suture/runtime/bridge';
import { startWorkerRuntime } from './workerRuntime.ts';

export interface BrowserPyodide {
  readonly handle: ReturnType<typeof createPyodideHandler>;
  readonly attachPeer: (port: MessagePort) => void;
}

/** Browser host: Pyodide from the pinned jsDelivr index; tables from DuckDB over the peer MessageChannel. */
export function createBrowserPyodide(): BrowserPyodide {
  let peer: MessagePort | null = null;
  let seq = 0;
  const waiters = new Map<number, (m: Extract<PeerMessage, { kind: 'peer.tables' }>) => void>();
  const handle = createPyodideHandler({
    bridgeSource,
    load: () => loadPyodide({ indexURL: `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`, stdout: () => undefined, stderr: () => undefined }),
    fetchTables: (ids: ReadonlyArray<ResultId>) => {
      const p = peer;
      if (p === null) return Promise.resolve({ protocol: PROTOCOL_VERSION, kind: 'peer.tables', peerRequestId: -1, tables: [], missing: [...ids] });
      const id = ++seq;
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        const msg: PeerMessage = { protocol: PROTOCOL_VERSION, kind: 'peer.fetch', peerRequestId: id, resultIds: [...ids] };
        p.postMessage(msg);
      });
    },
  });
  const attachPeer = (port: MessagePort): void => {
    peer = port;
    port.onmessage = (e: MessageEvent<unknown>) => {
      const m = e.data;
      if (!isPeerMessage(m) || m.kind !== 'peer.tables') return;
      const w = waiters.get(m.peerRequestId);
      waiters.delete(m.peerRequestId);
      w?.(m);
    };
  };
  return { handle, attachPeer };
}
