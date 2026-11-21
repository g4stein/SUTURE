import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPyodide } from 'pyodide';
import type { DuckDBConnection } from 'duckdb-wasm-blocking';
import type { EngineDeps } from '@suture/core';
import { createDuckDbHandler } from '../../src/workers/duckdbHandler.ts';
import { createPyodideHandler } from '../../src/workers/pyodideHandler.ts';
import { PyBridge, SqlBridge } from '../../src/workers/bridges.ts';
import type { EngineClient, RequestOptions } from '../../src/workers/portClient.ts';
import { PROTOCOL_VERSION, type PayloadOf, type RequestKind, type WorkerRequest, type WorkerResult } from '../../src/workers/protocol.ts';
import type { JobHandler } from '../../src/workers/workerRuntime.ts';

/**
 * Node host for the real engines: the exact DuckDB and Pyodide handlers the browser workers run, driven in-process.
 * DuckDB-WASM loads the same duckdb-eh.wasm through its synchronous Node bindings; Pyodide + NumPy are the real runtime.
 */
interface NodeBlocking {
  createDuckDB(bundles: { eh: { mainModule: string; mainWorker: string } }, logger: unknown, runtime: unknown): Promise<{
    instantiate(): Promise<unknown>;
    open(cfg: { query?: { castDecimalToDouble?: boolean; castBigIntToDouble?: boolean } }): void;
    connect(): DuckDBConnection;
    getVersion(): string;
  }>;
  VoidLogger: new () => unknown;
  NODE_RUNTIME: unknown;
}

const require = createRequire(import.meta.url);

/** Calls a handler directly, with the same request envelope a PortClient would post. Serialized like a worker queue. */
export class DirectClient implements EngineClient {
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly handler: JobHandler, private readonly portId = 0) {}

  request<K extends RequestKind>(kind: K, payload: PayloadOf<K>, opts: RequestOptions): Promise<WorkerResult> {
    const request = { protocol: PROTOCOL_VERSION, requestId: this.nextId++, generation: opts.generation, kind, priority: opts.priority, deadlineMs: opts.deadlineMs, payload } as WorkerRequest;
    const run = this.tail.then(() => {
      if (opts.signal?.aborted === true) return { kind: 'cancelled' } as const;
      return this.handler({ portId: this.portId, port: null, request, cancelled: false }, () => undefined);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export interface NodeEngines {
  readonly duckdb: DirectClient;
  readonly pyodide: DirectClient;
  readonly deps: EngineDeps;
  readonly validator: 'ast' | 'lexical';
  readonly versions: { readonly duckdb: string; readonly pyodide: string; readonly numpy: string };
  readonly bootMs: { readonly duckdb: number; readonly pyodide: number };
}

let shared: Promise<NodeEngines> | null = null;

/** Boots both real engines once per test file. */
export function nodeEngines(): Promise<NodeEngines> {
  shared ??= boot();
  return shared;
}

async function boot(): Promise<NodeEngines> {
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'suture-duckdb-')); // DuckDB extension cache
  const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const blocking = require(entry) as NodeBlocking;
  const duck = createDuckDbHandler({
    async open() {
      const db = await blocking.createDuckDB({ eh: { mainModule: join(dirname(entry), 'duckdb-eh.wasm'), mainWorker: '' } }, new blocking.VoidLogger(), blocking.NODE_RUNTIME);
      await db.instantiate();
      db.open({ query: { castDecimalToDouble: true, castBigIntToDouble: false } });
      return { conn: db.connect(), version: db.getVersion(), bundle: 'eh' };
    },
  });
  const py = createPyodideHandler({
    bridgeSource: readFileSync(new URL('../../src/workers/python/suture_bridge.py', import.meta.url), 'utf8'),
    load: () => loadPyodide({ stdout: () => undefined, stderr: () => undefined }),
    fetchTables: (ids) => Promise.resolve({ protocol: PROTOCOL_VERSION, kind: 'peer.tables', peerRequestId: 0, ...duck.peerFetch(ids) }),
  });
  const duckdb = new DirectClient(duck.handle);
  const pyodide = new DirectClient(py);
  const opts: RequestOptions = { priority: 'interactive', deadlineMs: 120_000, signal: null, generation: null };
  const t0 = performance.now();
  const d = await duckdb.request('duckdb.init', { isolation: { crossOriginIsolated: false, sharedArrayBuffer: true }, cancelBuffer: null }, opts);
  const t1 = performance.now();
  const p = await pyodide.request('py.init', { isolation: { crossOriginIsolated: false, sharedArrayBuffer: true }, interruptBuffer: null }, opts);
  const t2 = performance.now();
  if (d.kind !== 'duckdb.ready' || p.kind !== 'py.ready') throw new Error(`engine init failed: ${JSON.stringify(d)} ${JSON.stringify(p)}`);
  let clock = 0;
  const deps: EngineDeps = {
    sql: new SqlBridge(() => Promise.resolve(duckdb), 'interactive'),
    py: new PyBridge(() => Promise.resolve(pyodide), 'interactive'),
    clock: { now: () => (clock += 1) },
    yieldControl: () => Promise.resolve(),
  };
  return {
    duckdb, pyodide, deps, validator: d.validator,
    versions: { duckdb: d.duckdbVersion, pyodide: p.pyodideVersion, numpy: p.numpyVersion },
    bootMs: { duckdb: Math.round(t1 - t0), pyodide: Math.round(t2 - t1) },
  };
}

export async function nodeSha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
}
