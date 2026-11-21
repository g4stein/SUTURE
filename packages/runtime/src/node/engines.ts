/// <reference path="./env.d.ts" />
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPyodide } from 'pyodide';
import type { DuckDBConnection } from 'duckdb-wasm-blocking';
import type { EngineDeps } from '@suture/core';
import bridgeSource from '../engines/python/suture_bridge.py?raw';
import { createDuckDbHandler, type DuckDbHandler, type OpenedDuckDB } from '../engines/duckdbHandler.ts';
import { createPyodideHandler } from '../engines/pyodideHandler.ts';
import { PyBridge, SqlBridge } from '../bridge/bridges.ts';
import type { EngineClient, RequestOptions } from '../bridge/client.ts';
import type { JobHandler } from '../bridge/job.ts';
import { PROTOCOL_VERSION, type PayloadOf, type RequestKind, type WorkerRequest, type WorkerResult } from '../bridge/protocol.ts';

/**
 * Node host for the real engines: the exact DuckDB and Pyodide handlers the browser workers run, driven in-process
 * (Spec 05 §2). DuckDB-WASM loads the same duckdb-eh.wasm through its synchronous Node bindings; Pyodide + NumPy are the
 * real runtime. Requests run one at a time, like a worker queue. In-process execution cannot interrupt a kernel that never
 * returns, so a non-terminating `=PY()` or SQL operator blocks the host (Spec 05 Req 2.6); the Python trust gate in
 * `@suture/runtime/headless` keeps untrusted workbook code from running at all.
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

let duckdbHome: string | null = null;

/**
 * Opens DuckDB-WASM through the synchronous Node bindings (duckdb-wasm's `exports` map omits them, hence `createRequire`).
 * DuckDB installs the JSON and Parquet extensions under `$HOME/.duckdb`; the host points HOME at one private temporary
 * directory per process so it never writes into the user's home directory.
 */
export async function openNodeDuckDB(): Promise<OpenedDuckDB> {
  duckdbHome ??= mkdtempSync(join(tmpdir(), 'suture-duckdb-'));
  process.env['HOME'] = duckdbHome;
  const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const blocking = require(entry) as NodeBlocking;
  const db = await blocking.createDuckDB({ eh: { mainModule: join(dirname(entry), 'duckdb-eh.wasm'), mainWorker: '' } }, new blocking.VoidLogger(), blocking.NODE_RUNTIME);
  await db.instantiate();
  db.open({ query: { castDecimalToDouble: true, castBigIntToDouble: false } });
  return { conn: db.connect(), version: db.getVersion(), bundle: 'eh' };
}

/** Calls a handler directly, with the same request envelope a PortClient would post. Serialized like a worker queue. */
export class DirectClient implements EngineClient {
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly handler: JobHandler;
  private readonly portId: number;

  constructor(handler: JobHandler, portId = 0) {
    this.handler = handler;
    this.portId = portId;
  }

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

export interface DuckDbInfo {
  readonly version: string;
  readonly validator: 'ast' | 'lexical';
  readonly bootMs: number;
}

export interface PyodideInfo {
  readonly pyodideVersion: string;
  readonly numpyVersion: string;
  readonly bootMs: number;
}

/**
 * Both engines behind lazily booted clients: an engine starts on the first request that needs it, so a formula-only
 * workbook never boots Pyodide, and a workbook without `=PY()` never loads NumPy.
 */
export interface NodeEngineHost {
  readonly deps: EngineDeps;
  readonly duckdb: () => Promise<DirectClient>;
  readonly pyodide: () => Promise<DirectClient>;
  /** What has booted so far (null = not booted). */
  readonly info: () => { readonly duckdb: DuckDbInfo | null; readonly pyodide: PyodideInfo | null };
}

const INIT: RequestOptions = { priority: 'interactive', deadlineMs: 120_000, signal: null, generation: null };
const NODE_ISOLATION = { crossOriginIsolated: false, sharedArrayBuffer: true } as const;

export function createNodeEngineHost(): NodeEngineHost {
  const duck: DuckDbHandler = createDuckDbHandler({ open: openNodeDuckDB });
  const py = createPyodideHandler({
    bridgeSource,
    // Pyodide's own loader messages ("Loading numpy…") go to stderr: stdout belongs to the CLI's output and the MCP stream.
    load: () => loadPyodide({ stdout: () => undefined, stderr: () => undefined }),
    fetchTables: (ids) => Promise.resolve({ protocol: PROTOCOL_VERSION, kind: 'peer.tables', peerRequestId: 0, ...duck.peerFetch(ids) }),
  });
  const duckClient = new DirectClient(duck.handle, 1);
  const pyClient = new DirectClient(py, 2);
  let duckInfo: DuckDbInfo | null = null;
  let pyInfo: PyodideInfo | null = null;
  let duckReady: Promise<DirectClient> | null = null;
  let pyReady: Promise<DirectClient> | null = null;

  const duckdb = (): Promise<DirectClient> => {
    duckReady ??= (async () => {
      const t0 = performance.now();
      const r = await duckClient.request('duckdb.init', { isolation: NODE_ISOLATION, cancelBuffer: null }, INIT);
      if (r.kind !== 'duckdb.ready') throw new Error(`DuckDB init failed: ${r.kind === 'failed' ? r.message : r.kind}`);
      duckInfo = { version: r.duckdbVersion, validator: r.validator, bootMs: Math.round(performance.now() - t0) };
      return duckClient;
    })();
    return duckReady;
  };
  const pyodide = (): Promise<DirectClient> => {
    pyReady ??= (async () => {
      const t0 = performance.now();
      const r = await pyClient.request('py.init', { isolation: NODE_ISOLATION, interruptBuffer: null }, INIT);
      if (r.kind !== 'py.ready') throw new Error(`Pyodide init failed: ${r.kind === 'failed' ? r.message : r.kind}`);
      pyInfo = { pyodideVersion: r.pyodideVersion, numpyVersion: r.numpyVersion, bootMs: Math.round(performance.now() - t0) };
      return pyClient;
    })();
    return pyReady;
  };

  const deps: EngineDeps = {
    sql: new SqlBridge(duckdb, 'interactive'),
    py: new PyBridge(pyodide, 'interactive'),
    clock: { now: () => performance.timeOrigin + performance.now() },
    // Node hosts recalculate with sliceMs 0 (no frames to protect), so this is never awaited in practice.
    yieldControl: () => new Promise((resolve) => setImmediate(resolve)),
  };
  return { deps, duckdb, pyodide, info: () => ({ duckdb: duckInfo, pyodide: pyInfo }) };
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

/** Boots both real engines once per process (tests); CLI and MCP use `createNodeEngineHost` for lazy boot. */
export function nodeEngines(): Promise<NodeEngines> {
  shared ??= (async () => {
    const host = createNodeEngineHost();
    const duckdb = await host.duckdb();
    const pyodide = await host.pyodide();
    const { duckdb: d, pyodide: p } = host.info();
    if (d === null || p === null) throw new Error('engine boot did not report');
    return {
      duckdb, pyodide, deps: host.deps, validator: d.validator,
      versions: { duckdb: d.version, pyodide: p.pyodideVersion, numpy: p.numpyVersion },
      bootMs: { duckdb: d.bootMs, pyodide: p.bootMs },
    };
  })();
  return shared;
}
