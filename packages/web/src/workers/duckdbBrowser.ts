import { createDuckDB, getJsDelivrBundles, selectBundle, BROWSER_RUNTIME, VoidLogger } from 'duckdb-wasm-blocking';
import { createDuckDbHandler } from './duckdbHandler.ts';
import { isPeerMessage, PROTOCOL_VERSION, type PeerMessage } from './protocol.ts';

/** Browser host for the DuckDB handler (used by duckdb.worker.ts and the e2e-only chaos entry): synchronous bindings inside this top-level worker (zero nested workers). */
export const createBrowserDuckDb = (): ReturnType<typeof createDuckDbHandler> => createDuckDbHandler({
  async open(progress) {
    const all = getJsDelivrBundles();
    // Never the COI bundle: it spawns pthread sub-workers (steering architecture-and-isolation.md §2).
    const bundles = all.eh === undefined ? { mvp: all.mvp } : { mvp: all.mvp, eh: all.eh };
    const chosen = await selectBundle(bundles);
    const bundle: 'eh' | 'mvp' = all.eh !== undefined && chosen.mainModule === all.eh.mainModule ? 'eh' : 'mvp';
    const instance = await createDuckDB(bundle === 'eh' ? bundles : { mvp: all.mvp }, new VoidLogger(), BROWSER_RUNTIME);
    await instance.instantiate((p) => progress(p.bytesLoaded, p.bytesTotal > 0 ? p.bytesTotal : null));
    instance.open({ query: { castDecimalToDouble: true, castBigIntToDouble: false } });
    return { conn: instance.connect(), version: instance.getVersion(), bundle };
  },
});

export const servePeer = (duckdb: ReturnType<typeof createDuckDbHandler>) => (port: MessagePort): void => {
  port.onmessage = (e: MessageEvent<unknown>) => {
    const m = e.data;
    if (!isPeerMessage(m) || m.kind !== 'peer.fetch') return;
    const { tables, missing } = duckdb.peerFetch(m.resultIds);
    const reply: PeerMessage = { protocol: PROTOCOL_VERSION, kind: 'peer.tables', peerRequestId: m.peerRequestId, tables, missing };
    port.postMessage(reply, tables.map((t) => t.ipc.buffer as ArrayBuffer));
  };
};
