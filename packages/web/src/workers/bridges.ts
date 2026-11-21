import {
  makeError,
  type CancellationToken, type CellKey, type CellValue, type EngineBatchOutcome, type EngineOutcome, type PyBatchEvalRequest,
  type PyBinding, type PyEngine, type PyEvalRequest, type SqlBatchEvalRequest, type SqlEngine, type SqlEvalRequest, type SqlTableBinding, type TableRef,
} from '@suture/core';
import { DeadlineExceeded, EngineCrashed, signalFromToken, type EngineClient } from './portClient.ts';
import { owned, type Priority, type ResultId, type WirePyBinding, type WireTableBinding, type WorkerResult } from './protocol.ts';

export const DEADLINE_SINGLE_MS = 10_000;
export const DEADLINE_BATCH_MS = 60_000;

/** TableRef identity → DuckDB result id, so cached results are bound without re-sending bytes (Spec 02 Req 6.7). */
const resultIds = new WeakMap<TableRef, ResultId>();

function rememberTables(values: ReadonlyArray<CellValue>, ids: ReadonlyArray<ResultId | null>): void {
  values.forEach((v, i) => {
    const id = ids[i];
    if (id != null && v !== null && typeof v === 'object' && v.kind === 'table') resultIds.set(v, id);
  });
}

/** A transferable copy: the sender keeps its TableRef (it is a DAG value), the worker gets an owned slice. */
function copyTable(t: TableRef, transfer: Transferable[]): TableRef {
  const ipc = owned(t.ipc.slice());
  transfer.push(ipc.buffer as ArrayBuffer);
  return { ...t, ipc };
}

function wireTables(bs: ReadonlyArray<SqlTableBinding>, forceBytes: boolean, transfer: Transferable[]): WireTableBinding[] {
  return bs.map((b) => {
    const id = resultIds.get(b.table);
    return id !== undefined && !forceBytes
      ? { identifier: b.identifier, source: { kind: 'result', resultId: id } }
      : { identifier: b.identifier, source: { kind: 'ipc', table: copyTable(b.table, transfer) } };
  });
}

function wirePy(bs: ReadonlyArray<PyBinding>, forceBytes: boolean, transfer: Transferable[]): WirePyBinding[] {
  return bs.map((b) => {
    const v = b.value;
    if (v === null || typeof v !== 'object') return { key: b.key, value: { kind: 'scalar', value: v } };
    if (v.kind === 'matrix') return { key: b.key, value: { kind: 'matrix', value: { ...v, data: v.data.slice() } } };
    if (v.kind === 'range') return { key: b.key, value: { kind: 'range', value: v } };
    const id = resultIds.get(v);
    const source = id !== undefined && !forceBytes ? { kind: 'result' as const, resultId: id } : { kind: 'ipc' as const, table: copyTable(v, transfer) };
    return { key: b.key, value: { kind: 'table', source, schema: v.schema, rowCount: v.rowCount } };
  });
}

function failure(e: unknown, cell: CellKey, engine: 'sql' | 'py'): CellValue {
  if (e instanceof DeadlineExceeded) return makeError('#TIMEOUT!', e.message, cell, engine);
  if (e instanceof EngineCrashed) return makeError(engine === 'sql' ? '#SQL!' : '#PY!', e.message, cell, engine);
  return makeError(engine === 'sql' ? '#SQL!' : '#PY!', e instanceof Error ? e.message : String(e), cell, engine);
}

function one(r: WorkerResult, cell: CellKey, engine: 'sql' | 'py'): EngineOutcome {
  switch (r.kind) {
    case 'cancelled': return { kind: 'cancelled' };
    case 'value':
      if (r.resultId !== null) rememberTables([r.value], [r.resultId]);
      return { kind: 'value', value: r.value };
    case 'failed': return { kind: 'value', value: makeError(engine === 'sql' ? '#SQL!' : '#PY!', r.message, cell, engine) };
    default: return { kind: 'value', value: makeError(engine === 'sql' ? '#SQL!' : '#PY!', `unexpected worker result ${r.kind}`, cell, engine) };
  }
}

function many(r: WorkerResult, n: number, cell: CellKey, engine: 'sql' | 'py'): EngineBatchOutcome {
  if (r.kind === 'cancelled') return { kind: 'cancelled' };
  if (r.kind === 'values') {
    rememberTables(r.values, r.resultIds);
    return { kind: 'values', values: r.values };
  }
  const err = r.kind === 'failed' ? r.message : `unexpected worker result ${r.kind}`;
  return { kind: 'values', values: Array.from({ length: n }, () => makeError(engine === 'sql' ? '#SQL!' : '#PY!', err, cell, engine)) };
}

export class SqlBridge implements SqlEngine {
  constructor(private readonly client: () => Promise<EngineClient>, private readonly priority: Priority) {}

  async evaluate(req: SqlEvalRequest, token: CancellationToken): Promise<EngineOutcome> {
    try {
      const c = await this.client();
      for (const force of [false, true]) {
        const transfer: Transferable[] = [];
        const r = await c.request('duckdb.query', { cell: req.cell, sql: req.sql, params: req.params, tables: wireTables(req.tables, force, transfer) },
          { priority: this.priority, deadlineMs: DEADLINE_SINGLE_MS, signal: signalFromToken(token), generation: req.generation, transfer });
        if (r.kind !== 'missingTables') return one(r, req.cell, 'sql');
      }
      return { kind: 'value', value: makeError('#SQL!', 'bound tables are unavailable', req.cell, 'sql') };
    } catch (e) {
      return { kind: 'value', value: failure(e, req.cell, 'sql') };
    }
  }

  async evaluateBatch(req: SqlBatchEvalRequest, token: CancellationToken): Promise<EngineBatchOutcome> {
    try {
      const c = await this.client();
      for (const force of [false, true]) {
        const transfer: Transferable[] = [];
        const r = await c.request('duckdb.queryBatch', {
          cell: req.cell, sql: req.sql, shared: wireTables(req.shared, force, transfer),
          scenarios: req.scenarios.map((s) => ({ params: s.params, tables: wireTables(s.tables, force, transfer) })),
        }, { priority: this.priority, deadlineMs: DEADLINE_BATCH_MS, signal: signalFromToken(token), generation: req.generation, transfer });
        if (r.kind !== 'missingTables') return many(r, req.scenarios.length, req.cell, 'sql');
      }
      return { kind: 'values', values: req.scenarios.map(() => makeError('#SQL!', 'bound tables are unavailable', req.cell, 'sql')) };
    } catch (e) {
      const v = failure(e, req.cell, 'sql');
      return { kind: 'values', values: req.scenarios.map(() => v) };
    }
  }
}

export class PyBridge implements PyEngine {
  constructor(private readonly client: () => Promise<EngineClient>, private readonly priority: Priority) {}

  async evaluate(req: PyEvalRequest, token: CancellationToken): Promise<EngineOutcome> {
    try {
      const c = await this.client();
      for (const force of [false, true]) {
        const transfer: Transferable[] = [];
        const r = await c.request('py.run', { cell: req.cell, code: req.code, vectorized: req.vectorized, seed: req.seed, inputs: wirePy(req.inputs, force, transfer) },
          { priority: this.priority, deadlineMs: DEADLINE_SINGLE_MS, signal: signalFromToken(token), generation: req.generation, transfer });
        if (r.kind !== 'missingTables') return one(r, req.cell, 'py');
      }
      return { kind: 'value', value: makeError('#PY!', 'bound tables are unavailable', req.cell, 'py') };
    } catch (e) {
      return { kind: 'value', value: failure(e, req.cell, 'py') };
    }
  }

  async evaluateBatch(req: PyBatchEvalRequest, token: CancellationToken): Promise<EngineBatchOutcome> {
    try {
      const c = await this.client();
      for (const force of [false, true]) {
        const transfer: Transferable[] = [];
        const r = await c.request('py.runBatch', {
          cell: req.cell, code: req.code, vectorized: req.vectorized, seed: req.seed,
          shared: wirePy(req.shared, force, transfer), scenarios: req.scenarios.map((s) => wirePy(s, force, transfer)),
        }, { priority: this.priority, deadlineMs: DEADLINE_BATCH_MS, signal: signalFromToken(token), generation: req.generation, transfer });
        if (r.kind !== 'missingTables') return many(r, req.scenarios.length, req.cell, 'py');
      }
      return { kind: 'values', values: req.scenarios.map(() => makeError('#PY!', 'bound tables are unavailable', req.cell, 'py')) };
    } catch (e) {
      const v = failure(e, req.cell, 'py');
      return { kind: 'values', values: req.scenarios.map(() => v) };
    }
  }
}
