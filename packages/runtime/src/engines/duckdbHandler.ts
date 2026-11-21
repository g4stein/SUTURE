import type { DuckDBConnection } from 'duckdb-wasm-blocking';
import {
  collapseSqlResult, decodeTable, makeError, normalizeTable, schemaOf, tableRefFromIPC,
  type ArrowField, type CellKey, type CellValue, type DatasetMeta, type ScalarValue, type TableRef,
} from '@suture/core';
import { execSql, queryIPC } from './duckdbIpc.ts';
import type { DuckDbQueryBatchPayload, RegisterDatasetPayload, ResultId, WireTableBinding, WorkerResult } from '../bridge/protocol.ts';
import { FatalEngineError, ticketOf, type Job, type JobHandler } from '../bridge/job.ts';
import { parseSerializedSql, validateLexical, validateSerializedSql, type SqlValidation, type SqlValidatorKind } from './sqlValidate.ts';

/**
 * Host-agnostic DuckDB request handling (Spec 02 §5). The browser worker (`packages/web` `duckdb.worker.ts`) and the Node host
 * (`@suture/runtime/node`: tests, CLI, MCP) run exactly this code; only `open` (which DuckDB-WASM bindings to instantiate) differs.
 */

// Spec 02 §5.4 — deterministic macros (lowbias32 identical to core mix32's finalizer).
export const MACROS: ReadonlyArray<string> = [
  'CREATE OR REPLACE MACRO suture_m32(x) AS (x::UBIGINT & 4294967295::UBIGINT)',
  'CREATE OR REPLACE MACRO suture_xs(x, s) AS xor(x, x >> s)',
  'CREATE OR REPLACE MACRO suture_mul(x, c) AS ((x::UBIGINT * c::UBIGINT) & 4294967295::UBIGINT)',
  'CREATE OR REPLACE MACRO suture_h32(x) AS suture_xs(suture_mul(suture_xs(suture_mul(suture_xs(suture_m32(x), 16), 2146121005), 15), 2221713035), 16)',
  'CREATE OR REPLACE MACRO suture_u01(i, stream) AS suture_h32(xor(suture_m32(i), suture_h32(suture_m32(stream + 2654435769)))) / 4294967296.0',
  'CREATE OR REPLACE MACRO suture_normal(i, stream) AS sqrt(-2.0 * ln(1.0 - suture_u01(i, stream))) * cos(2.0 * pi() * suture_u01(i, stream + 1000))',
];
export const EXTENSION_TIMEOUT_MS = 3000;
const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const PREVIEW_ROWS = 100;

export interface OpenedDuckDB {
  readonly conn: DuckDBConnection;
  readonly version: string; // "v1.4.3"
  readonly bundle: 'eh' | 'mvp';
}

export interface DuckDbHandlerEnv {
  readonly open: (progress: (loaded: number, total: number | null) => void) => Promise<OpenedDuckDB>;
}

interface CachedResult {
  readonly ipc: Uint8Array;
  materialized: string | null;
  lastUse: number;
}

export interface DuckDbHandler {
  readonly handle: JobHandler;
  /** Peer fetch (Pyodide ↔ DuckDB MessageChannel): copies of cached result bytes. */
  readonly peerFetch: (ids: ReadonlyArray<ResultId>) => { readonly tables: Array<{ resultId: ResultId; ipc: Uint8Array }>; readonly missing: ResultId[] };
}

/** DuckDB errors arrive as JSON ({"exception_type": …, "exception_message": …}) or plain text. */
export function duckdbMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(raw) as { exception_type?: string; exception_message?: string };
    if (typeof j.exception_message === 'string') return `${j.exception_type ?? 'Error'}: ${j.exception_message}`;
  } catch {
    // plain-text message
  }
  return raw;
}

const quoteIdent = (s: string): string => `"${s.replaceAll('"', '""')}"`;
const quoteLit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const INTERNAL = 'Suture!A1' as CellKey;

export function createDuckDbHandler(env: DuckDbHandlerEnv): DuckDbHandler {
  let conn: DuckDBConnection | null = null;
  let version = '';
  let bundle: 'eh' | 'mvp' = 'eh';
  let validator: SqlValidatorKind = 'lexical';
  let cancel: Int32Array | null = null;
  let epoch = 0;
  let useCounter = 0;
  let tempCounter = 0;
  const cache = new Map<ResultId, CachedResult>();
  const datasets = new Set<string>();
  const extensions = new Map<string, Promise<boolean>>();

  const db = (): DuckDBConnection => {
    if (conn === null) throw new FatalEngineError('DuckDB is not initialized');
    return conn;
  };
  const exec = (sql: string): void => execSql(db(), sql);
  const scalarQuery = (sql: string, params: ReadonlyArray<ScalarValue> = []): CellValue => {
    const out = queryIPC(db(), sql, params, () => false);
    if (out === 'cancelled') throw new Error('cancelled');
    return collapseSqlResult(tableRefFromIPC(out), INTERNAL);
  };

  const drop = (id: ResultId): void => {
    const c = cache.get(id);
    if (c?.materialized != null) exec(`DROP TABLE IF EXISTS ${quoteIdent(c.materialized)}`);
    cache.delete(id);
  };
  const evictIfNeeded = (): void => {
    let bytes = 0;
    for (const c of cache.values()) bytes += c.ipc.byteLength;
    while (bytes > CACHE_LIMIT_BYTES && cache.size > 0) {
      let oldest: ResultId | null = null;
      let t = Infinity;
      for (const [id, c] of cache) if (c.lastUse < t) { t = c.lastUse; oldest = id; }
      if (oldest === null) break;
      bytes -= cache.get(oldest)?.ipc.byteLength ?? 0;
      drop(oldest);
    }
  };

  /**
   * Loads a DuckDB extension explicitly (autoload is off). The extension is fetched asynchronously first under a 3 s
   * AbortController guard, so a slow/offline CDN never stalls the engine; the synchronous INSTALL then hits the HTTP cache.
   * Memoized per extension: Parquet is loaded only on the first Parquet upload, never at boot.
   */
  const loadExtension = (name: 'json' | 'parquet'): Promise<boolean> => {
    const existing = extensions.get(name);
    if (existing !== undefined) return existing;
    const p = (async (): Promise<boolean> => {
      const url = `https://extensions.duckdb.org/${version}/${bundle === 'eh' ? 'wasm_eh' : 'wasm_mvp'}/${name}.duckdb_extension.wasm`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), EXTENSION_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctl.signal, mode: 'cors', credentials: 'omit' });
        if (!res.ok) return false;
        await res.arrayBuffer();
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
      try {
        exec(`INSTALL ${name}`);
        exec(`LOAD ${name}`);
        return true;
      } catch {
        return false;
      }
    })();
    extensions.set(name, p);
    void p.then((ok) => { if (!ok) extensions.delete(name); });
    return p;
  };

  const chooseValidator = async (): Promise<SqlValidatorKind> => {
    if (!(await loadExtension('json'))) return 'lexical';
    try {
      const j = scalarQuery("SELECT json_serialize_sql('SELECT 1', skip_default := true, skip_null := true, skip_empty := true) AS j");
      const parsed = typeof j === 'string' ? (parseSerializedSql(j) as { error?: unknown }) : null;
      return parsed?.error === false ? 'ast' : 'lexical';
    } catch {
      return 'lexical';
    }
  };

  /** Validation is a pure function of (validator, SQL text, allowed tables): memoized so batches validate once. */
  const validated = new Map<string, SqlValidation>();
  const validate = (sql: string, allowed: ReadonlySet<string>): SqlValidation => {
    const memoKey = `${validator}\u0000${[...allowed].sort().join(',')}\u0000${sql}`;
    const hit = validated.get(memoKey);
    if (hit !== undefined) return hit;
    const v = validateUncached(sql, allowed);
    if (validated.size > 4096) validated.clear();
    validated.set(memoKey, v);
    return v;
  };
  const validateUncached = (sql: string, allowed: ReadonlySet<string>): SqlValidation => {
    if (validator === 'lexical') return validateLexical(sql, allowed);
    const j = scalarQuery('SELECT json_serialize_sql($1::VARCHAR, skip_default := true, skip_null := true, skip_empty := true) AS j', [sql]);
    if (typeof j !== 'string') return { ok: false, reason: 'json_serialize_sql returned no text' };
    return validateSerializedSql(parseSerializedSql(j), allowed);
  };

  const cancelRequested = (job: Job): boolean => {
    if (cancel === null || Atomics.load(cancel, 0) === 0) return false;
    const mine = Atomics.load(cancel, 1) === ticketOf(job.portId, job.request.requestId);
    Atomics.store(cancel, 0, 0); // on a ticket mismatch the target already finished: clear and continue
    return mine;
  };

  const bind = (bindings: ReadonlyArray<WireTableBinding>): { readonly missing: ResultId[]; readonly cleanup: string[] } => {
    const missing: ResultId[] = [];
    const cleanup: string[] = [];
    for (const b of bindings) {
      let source: string;
      if (b.source.kind === 'result') {
        const c = cache.get(b.source.resultId);
        if (c === undefined) { missing.push(b.source.resultId); continue; }
        c.lastUse = ++useCounter;
        if (c.materialized === null) {
          const name = `__res_${(tempCounter++).toString(36)}`;
          db().insertArrowFromIPCStream(c.ipc, { name, create: true });
          c.materialized = name;
        }
        source = c.materialized;
      } else {
        const name = `__ipc_${(tempCounter++).toString(36)}`;
        db().insertArrowFromIPCStream(b.source.table.ipc, { name, create: true });
        cleanup.push(name);
        source = name;
      }
      exec(`CREATE OR REPLACE TEMP VIEW ${quoteIdent(b.identifier)} AS SELECT * FROM ${quoteIdent(source)}`);
    }
    return { missing, cleanup };
  };
  const unbind = (bindings: ReadonlyArray<WireTableBinding>, cleanup: ReadonlyArray<string>): void => {
    for (const b of bindings) exec(`DROP VIEW IF EXISTS ${quoteIdent(b.identifier)}`);
    for (const t of cleanup) exec(`DROP TABLE IF EXISTS ${quoteIdent(t)}`);
  };

  type RunOutcome = { readonly value: CellValue; readonly resultId: ResultId | null } | 'cancelled';

  const runQuery = (job: Job, cell: CellKey, sql: string, params: ReadonlyArray<ScalarValue>, bindings: ReadonlyArray<WireTableBinding>, scenario: number): RunOutcome => {
    const v = validate(sql, new Set<string>([...datasets, ...bindings.map((b) => b.identifier)]));
    if (!v.ok) return { value: makeError('#SQL!', v.reason, cell, 'sql'), resultId: null };
    try {
      // DuckDB's own Arrow IPC bytes, read chunk by chunk; the cancel flag is checked before every chunk.
      const bytes = queryIPC(db(), sql, params, () => cancelRequested(job));
      if (bytes === 'cancelled') return 'cancelled';
      const ref = tableRefFromIPC(bytes);
      const normalized = normalizeTable(ref, cell, 'sql');
      if (normalized.kind === 'error') return { value: normalized, resultId: null };
      const collapsed = collapseSqlResult(normalized, cell);
      if (typeof collapsed === 'object' && collapsed !== null && collapsed.kind === 'table') {
        const resultId = `r${epoch}.${job.portId}.${job.request.requestId}.${scenario}`;
        cache.set(resultId, { ipc: ref.ipc, materialized: null, lastUse: ++useCounter });
        evictIfNeeded();
        // The cache keeps its own copy; the client receives a transferred slice (Spec 02 §4.1).
        return { value: { ...collapsed, ipc: ref.ipc.slice() }, resultId };
      }
      return { value: collapsed, resultId: null };
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) throw e;
      return { value: makeError('#SQL!', duckdbMessage(e), cell, 'sql'), resultId: null };
    }
  };

  const runBatch = (job: Job, p: DuckDbQueryBatchPayload): WorkerResult => {
    const shared = bind(p.shared);
    try {
      const missing = [...shared.missing];
      const values: CellValue[] = [];
      const resultIds: Array<ResultId | null> = [];
      for (let i = 0; i < p.scenarios.length; i++) {
        const s = p.scenarios[i];
        if (s === undefined) continue;
        const own = bind(s.tables);
        try {
          missing.push(...own.missing);
          if (missing.length > 0) continue;
          const out = runQuery(job, p.cell, p.sql, s.params, [...p.shared, ...s.tables], i);
          if (out === 'cancelled') return { kind: 'cancelled' };
          values.push(out.value);
          resultIds.push(out.resultId);
        } finally {
          unbind(s.tables, own.cleanup);
        }
      }
      if (missing.length > 0) return { kind: 'missingTables', resultIds: [...new Set(missing)] };
      return { kind: 'values', values, resultIds };
    } finally {
      unbind(p.shared, shared.cleanup);
    }
  };

  /** Spec 02 Req 5: CSV via registerFileBuffer + read_csv_auto, Parquet via the lazily loaded extension, Arrow via IPC insert. */
  const registerDataset = async (p: RegisterDatasetPayload): Promise<WorkerResult> => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(p.name)) return { kind: 'failed', message: `invalid dataset name "${p.name}"` };
    const table = quoteIdent(p.name);
    const file = `__upload_${p.name}.${p.encoding === 'parquet' ? 'parquet' : 'csv'}`;
    try {
      exec(`DROP TABLE IF EXISTS ${table}`);
      if (p.encoding === 'arrow') {
        db().insertArrowFromIPCStream(p.bytes, { name: p.name, create: true });
      } else {
        if (p.encoding === 'parquet' && !(await loadExtension('parquet'))) {
          return { kind: 'failed', message: 'the Parquet reader could not be loaded (network unavailable or slower than 3 s); CSV and spreadsheet imports still work' };
        }
        db().useUnsafe((b) => b.registerFileBuffer(file, p.bytes.slice()));
        try {
          const reader = p.encoding === 'parquet' ? `read_parquet(${quoteLit(file)})` : `read_csv_auto(${quoteLit(file)}, header = true, sample_size = -1)`;
          exec(`CREATE TABLE ${table} AS SELECT * FROM ${reader}`);
        } finally {
          db().useUnsafe((b) => b.dropFile(file));
        }
      }
      datasets.add(p.name);
      const rows = scalarQuery(`SELECT count(*)::DOUBLE AS n FROM ${table}`);
      const previewBytes = queryIPC(db(), `SELECT * FROM ${table} LIMIT ${PREVIEW_ROWS}`, [], () => false);
      if (previewBytes === 'cancelled') return { kind: 'cancelled' };
      const preview: TableRef = tableRefFromIPC(previewBytes);
      const schema: ArrowField[] = schemaOf(decodeTable(preview));
      const meta: DatasetMeta = { name: p.name, format: p.sourceFormat, sha256: p.sha256, byteLength: p.bytes.byteLength, rowCount: typeof rows === 'number' ? rows : 0, schema };
      return { kind: 'dataset', meta, preview };
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) throw e;
      datasets.delete(p.name);
      return { kind: 'failed', message: duckdbMessage(e) };
    }
  };

  const handle: JobHandler = async (job, progress) => {
    const r = job.request;
    switch (r.kind) {
      case 'duckdb.init': {
        cancel = r.payload.cancelBuffer === null ? null : new Int32Array(r.payload.cancelBuffer);
        progress('download', 0, null);
        const opened = await env.open((loaded, total) => progress('download', loaded, total));
        conn = opened.conn;
        version = opened.version.startsWith('v') ? opened.version : `v${opened.version}`;
        bundle = opened.bundle;
        progress('bootstrap', 0, null);
        for (const s of ['SET autoinstall_known_extensions = false', 'SET autoload_known_extensions = false', 'SET threads = 1', 'SET preserve_insertion_order = true', ...MACROS]) exec(s);
        epoch++;
        validator = await chooseValidator();
        return { kind: 'duckdb.ready', bundle, duckdbVersion: version, validator };
      }
      case 'duckdb.query': {
        const p = r.payload;
        const b = bind(p.tables);
        try {
          if (b.missing.length > 0) return { kind: 'missingTables', resultIds: b.missing };
          const out = runQuery(job, p.cell, p.sql, p.params, p.tables, 0);
          if (out === 'cancelled') return { kind: 'cancelled' };
          return { kind: 'value', value: out.value, resultId: out.resultId };
        } finally {
          unbind(p.tables, b.cleanup);
        }
      }
      case 'duckdb.queryBatch':
        return runBatch(job, r.payload);
      case 'duckdb.releaseResults':
        for (const id of r.payload.resultIds) drop(id);
        return { kind: 'ack' };
      case 'duckdb.registerDataset':
        return registerDataset(r.payload);
      case 'duckdb.dropDataset':
        exec(`DROP TABLE IF EXISTS ${quoteIdent(r.payload.name)}`);
        datasets.delete(r.payload.name);
        return { kind: 'ack' };
      default:
        return { kind: 'failed', message: `the DuckDB worker does not handle ${r.kind}` };
    }
  };

  const peerFetch: DuckDbHandler['peerFetch'] = (ids) => {
    const tables: Array<{ resultId: ResultId; ipc: Uint8Array }> = [];
    const missing: ResultId[] = [];
    for (const id of ids) {
      const c = cache.get(id);
      if (c === undefined) missing.push(id);
      else {
        c.lastUse = ++useCounter;
        tables.push({ resultId: id, ipc: c.ipc.slice() });
      }
    }
    return { tables, missing };
  };

  return { handle, peerFetch };
}
