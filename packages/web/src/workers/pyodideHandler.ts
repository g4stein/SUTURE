import type { PyodideAPI } from 'pyodide';
import { makeError, normalizeMatrix, normalizeNumber, type CellKey, type CellValue, type CellErrorCode } from '@suture/core';
import { columnSpecs, type ColumnSpec } from './arrowColumns.ts';
import { ownedF64, type PeerMessage, type ResultId, type WirePyBinding, type WorkerResult } from './protocol.ts';
import { FatalEngineError, ticketOf, type Job, type JobHandler } from './workerRuntime.ts';
import { diag } from './diag.ts'; // DIAG(temp)

/**
 * Host-agnostic Pyodide request handling (Spec 02 §4.3–4.5, Option C). The browser worker and the Node test host run
 * exactly this code; only `load` (where Pyodide comes from) and `fetchTables` (the DuckDB peer channel) differ.
 */
export interface PyodideHandlerEnv {
  readonly load: () => Promise<PyodideAPI>;
  readonly bridgeSource: string;
  readonly fetchTables: (ids: ReadonlyArray<ResultId>) => Promise<Extract<PeerMessage, { kind: 'peer.tables' }>>;
}

export function createPyodideHandler(env: PyodideHandlerEnv): JobHandler {

  type PyProxyLike = {
    get(i: number): unknown;
    length: number;
    destroy(): void;
    getBuffer(type: 'f64'): { data: Float64Array; release(): void };
    toJs(): unknown;
  };

  let py: PyodideAPI | null = null;
  let interrupt: Int32Array | null = null;
  const fetchTables = env.fetchTables;

  function api(): PyodideAPI {
    if (py === null) throw new FatalEngineError('Pyodide is not initialized');
    return py;
  }

  type Resolved =
    | { readonly kind: 'scalar'; readonly type: 'null' | 'number' | 'string' | 'boolean'; readonly value: number | string | boolean }
    | { readonly kind: 'matrix'; readonly rows: number; readonly cols: number; readonly data: Float64Array }
    | { readonly kind: 'table'; readonly columns: ReadonlyArray<ColumnSpec> }
    | { readonly kind: 'range'; readonly rows: number; readonly cols: number; readonly numeric: boolean; readonly data: Float64Array; readonly validity: Uint8Array; readonly values: ReadonlyArray<unknown> };

  /** Resolves wire bindings: tables via the peer port (zero-copy transfer) and apache-arrow views (no copy). */
  async function resolveBindings(cell: CellKey, groups: ReadonlyArray<ReadonlyArray<WirePyBinding>>):
    Promise<{ readonly ok: true; readonly groups: Array<Array<{ key: string; value: Resolved }>> } | { readonly ok: false; readonly missing: ResultId[] } | { readonly ok: false; readonly error: CellValue }> {
    const wanted = new Set<ResultId>();
    for (const g of groups) for (const b of g) if (b.value.kind === 'table' && b.value.source.kind === 'result') wanted.add(b.value.source.resultId);
    const fetched = new Map<ResultId, Uint8Array>();
    if (wanted.size > 0) {
      const reply = await fetchTables([...wanted]);
      if (reply.missing.length > 0) return { ok: false, missing: [...reply.missing] };
      for (const t of reply.tables) fetched.set(t.resultId, t.ipc);
    }
    const out: Array<Array<{ key: string; value: Resolved }>> = [];
    for (const g of groups) {
      const row: Array<{ key: string; value: Resolved }> = [];
      for (const b of g) {
        const v = b.value;
        if (v.kind === 'scalar') {
          const x = v.value;
          row.push({ key: b.key, value: x === null ? { kind: 'scalar', type: 'null', value: 0 } : { kind: 'scalar', type: typeof x === 'number' ? 'number' : typeof x === 'boolean' ? 'boolean' : 'string', value: x } });
        } else if (v.kind === 'matrix') {
          row.push({ key: b.key, value: { kind: 'matrix', rows: v.value.rows, cols: v.value.cols, data: v.value.data } });
        } else if (v.kind === 'range') {
          const r = v.value;
          const numeric = r.values.every((x) => x === null || typeof x === 'number');
          const data = new Float64Array(r.values.length);
          const validity = new Uint8Array(r.values.length);
          r.values.forEach((x, i) => { if (typeof x === 'number') { data[i] = x; validity[i] = 1; } });
          row.push({ key: b.key, value: { kind: 'range', rows: r.rows, cols: r.cols, numeric, data, validity, values: r.values } });
        } else {
          const ipc = v.source.kind === 'result' ? fetched.get(v.source.resultId) : v.source.table.ipc;
          if (ipc === undefined) return { ok: false, missing: v.source.kind === 'result' ? [v.source.resultId] : [] };
          const specs = columnSpecs(ipc);
          if (!specs.ok) return { ok: false, error: makeError('#PY!', `column "${specs.column}" has unsupported Arrow type ${specs.arrowType}`, cell, 'py') };
          row.push({ key: b.key, value: { kind: 'table', columns: specs.columns } });
        }
      }
      out.push(row);
    }
    return { ok: true, groups: out };
  }

  function convert(item: PyProxyLike, cell: CellKey): CellValue {
    const tag = item.get(0) as string;
    switch (tag) {
      case 'null': return null;
      case 'bool': return item.get(1) as boolean;
      case 'str': return item.get(1) as string;
      case 'num': return normalizeNumber(item.get(1) as number, item.get(2) === true ? 'divisionByZero' : 'none', cell, 'py');
      case 'mat': {
        const arr = item.get(3) as PyProxyLike;
        try {
          const buf = arr.getBuffer('f64');
          try {
            const data = ownedF64(new Float64Array(buf.data)); // copy out of WASM memory
            return normalizeMatrix({ kind: 'matrix', rows: item.get(1) as number, cols: item.get(2) as number, data }, item.get(4) === true ? 'divisionByZero' : 'none', cell, 'py');
          } finally {
            buf.release();
          }
        } finally {
          arr.destroy();
        }
      }
      case 'err': return makeError(item.get(1) as CellErrorCode, item.get(2) as string, cell, 'py');
      default: return makeError('#PY!', `bridge returned unknown tag ${String(tag)}`, cell, 'py');
    }
  }

  async function runBatch(job: Job, cell: CellKey, code: string, vectorized: boolean, seed: number, shared: ReadonlyArray<WirePyBinding>, scenarios: ReadonlyArray<ReadonlyArray<WirePyBinding>>): Promise<WorkerResult> {
    const resolved = await resolveBindings(cell, [shared, ...scenarios]);
    if (!resolved.ok) {
      if ('missing' in resolved) return { kind: 'missingTables', resultIds: resolved.missing };
      return { kind: 'values', values: scenarios.map(() => resolved.error), resultIds: scenarios.map(() => null) };
    }
    const [sharedResolved = [], ...scenarioResolved] = resolved.groups;
    const fn = api().globals.get('run_batch') as (...a: unknown[]) => PyProxyLike;
    for (;;) {
      let result: PyProxyLike | null = null;
      try {
        diag('py.callStart', { requestId: job.request.requestId, cell, signal: interrupt === null ? null : Atomics.load(interrupt, 0) });
        result = fn(code, vectorized, seed, sharedResolved, scenarioResolved, `<cell ${cell}>`);
        const first = result.length > 0 ? (result.get(0) as PyProxyLike) : null;
        const isInt = first !== null && first.get(0) === 'interrupt';
        diag('py.returned', { requestId: job.request.requestId, tag: first === null ? null : String(first.get(0)), pyCaughtAtMs: isInt ? first.get(1) : null, pyExecStartAtMs: isInt ? first.get(2) : null, signal: interrupt === null ? null : Atomics.load(interrupt, 0) });
        if (first !== null && first.get(0) === 'interrupt') {
          first.destroy();
          const mine = interrupt !== null && Atomics.load(interrupt, 1) === ticketOf(job.portId, job.request.requestId);
          diag('py.interruptTicket', { requestId: job.request.requestId, mine, inBuffer: interrupt === null ? null : Atomics.load(interrupt, 1), expected: ticketOf(job.portId, job.request.requestId) });
          if (interrupt !== null) Atomics.store(interrupt, 0, 0);
          if (mine) return { kind: 'cancelled' };
          continue; // ticket mismatch: the interrupt targeted another job; evaluation is deterministic, so re-run
        }
        first?.destroy();
        const values: CellValue[] = [];
        for (let i = 0; i < result.length; i++) {
          const item = result.get(i) as PyProxyLike;
          try {
            values.push(convert(item, cell));
          } finally {
            item.destroy();
          }
        }
        return { kind: 'values', values, resultIds: values.map(() => null) };
      } catch (e) {
        diag('py.escapedToJs', { requestId: job.request.requestId, name: e instanceof Error ? e.name : typeof e, message: (e instanceof Error ? e.message : String(e)).slice(-600), signal: interrupt === null ? null : Atomics.load(interrupt, 0) });
        // Every Python exception is caught inside the bridge; anything escaping to JS is a fatal engine state.
        throw new FatalEngineError(e instanceof Error ? e.message : String(e));
      } finally {
        result?.destroy();
      }
    }
  }

  async function handle(job: Job, progress: (phase: 'download' | 'compile' | 'packages' | 'bootstrap', loaded: number, total: number | null) => void): Promise<WorkerResult> {
    const r = job.request;
    switch (r.kind) {
      case 'py.init': {
        progress('download', 0, null);
        py = await env.load();
        progress('packages', 0, null);
        await py.loadPackage(['numpy'], { messageCallback: () => undefined, errorCallback: () => undefined });
        if (r.payload.interruptBuffer !== null) {
          interrupt = new Int32Array(r.payload.interruptBuffer);
          Atomics.store(interrupt, 0, 0); // defensive: never inherit a pending SIGINT from a previous worker
          py.setInterruptBuffer(interrupt);
        }
        diag('py.interruptArmed', { armed: interrupt !== null, shared: r.payload.interruptBuffer instanceof SharedArrayBuffer, coi: (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true, pyodide: py.version });
        progress('bootstrap', 0, null);
        py.runPython(env.bridgeSource);
        const numpyVersion = String((py.globals.get('numpy_version') as () => string)());
        return { kind: 'py.ready', pyodideVersion: py.version, numpyVersion, interrupt: interrupt !== null };
      }
      case 'py.run': {
        const p = r.payload;
        const out = await runBatch(job, p.cell, p.code, p.vectorized, p.seed, [], [p.inputs]);
        if (out.kind === 'values') return { kind: 'value', value: out.values[0] ?? null, resultId: null };
        return out;
      }
      case 'py.runBatch': {
        const p = r.payload;
        return runBatch(job, p.cell, p.code, p.vectorized, p.seed, p.shared, p.scenarios);
      }
      default:
        return { kind: 'failed', message: `the Pyodide worker does not handle ${r.kind}` };
    }
  }

  return handle;
}
