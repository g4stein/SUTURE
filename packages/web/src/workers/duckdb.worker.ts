import { createDuckDB, getJsDelivrBundles, selectBundle, BROWSER_RUNTIME, VoidLogger, type DuckDBConnection } from 'duckdb-wasm-blocking';
import { collapseSqlResult, makeError, normalizeTable, tableRefFromIPC, type CellKey, type CellValue, type ScalarValue } from '@suture/core';
import { execSql, queryIPC } from './duckdbIpc.ts';
import {
  isPeerMessage, PROTOCOL_VERSION,
  type DuckDbQueryBatchPayload, type PeerMessage, type ResultId, type WireTableBinding, type WorkerResult,
} from './protocol.ts';
import { FatalEngineError, startWorkerRuntime, ticketOf, type Job } from './workerRuntime.ts';
import { parseSerializedSql, validateLexical, validateSerializedSql, type SqlValidation, type SqlValidatorKind } from './sqlValidate.ts';

// Spec 02 §5.4 — deterministic macros (lowbias32 identical to core mix32's finalizer).
const MACROS = [
  'CREATE OR REPLACE MACRO suture_m32(x) AS (x::UBIGINT & 4294967295::UBIGINT)',
  'CREATE OR REPLACE MACRO suture_xs(x, s) AS xor(x, x >> s)',
  'CREATE OR REPLACE MACRO suture_mul(x, c) AS ((x::HUGEINT * c) % 4294967296)::UBIGINT',
  'CREATE OR REPLACE MACRO suture_h32(x) AS suture_xs(suture_mul(suture_xs(suture_mul(suture_xs(suture_m32(x), 16), 2146121005), 15), 2221713035), 16)',
  'CREATE OR REPLACE MACRO suture_u01(i, stream) AS suture_h32(xor(suture_m32(i), suture_h32(suture_m32(stream + 2654435769)))) / 4294967296.0',
  'CREATE OR REPLACE MACRO suture_normal(i, stream) AS sqrt(-2.0 * ln(1.0 - suture_u01(i, stream))) * cos(2.0 * pi() * suture_u01(i, stream + 1000))',
];
const JSON_EXTENSION_TIMEOUT_MS = 3000;
const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

interface CachedResult {
  readonly ipc: Uint8Array;
  materialized: string | null;
  lastUse: number;
}

let conn: DuckDBConnection | null = null;
let validator: SqlValidatorKind = 'lexical';
let cancel: Int32Array | null = null;
let epoch = 0;
let useCounter = 0;
let tempCounter = 0;
const cache = new Map<ResultId, CachedResult>();
const datasets = new Set<string>();

function db(): DuckDBConnection {
  if (conn === null) throw new FatalEngineError('DuckDB is not initialized');
  return conn;
}

function exec(sql: string): void {
  execSql(db(), sql);
}

function cacheBytes(): number {
  let n = 0;
  for (const c of cache.values()) n += c.ipc.byteLength;
  return n;
}

function evictIfNeeded(): void {
  while (cacheBytes() > CACHE_LIMIT_BYTES && cache.size > 0) {
    let oldest: ResultId | null = null;
    let t = Infinity;
    for (const [id, c] of cache) if (c.lastUse < t) { t = c.lastUse; oldest = id; }
    if (oldest === null) break;
    drop(oldest);
  }
}

function drop(id: ResultId): void {
  const c = cache.get(id);
  if (c?.materialized != null) exec(`DROP TABLE IF EXISTS "${c.materialized}"`);
  cache.delete(id);
}

/** Probes `json_serialize_sql` after an explicit INSTALL/LOAD json, bounded by a 3 s network timeout. */
async function chooseValidator(version: string, bundle: 'eh' | 'mvp'): Promise<SqlValidatorKind> {
  const platform = bundle === 'eh' ? 'wasm_eh' : 'wasm_mvp';
  const url = `https://extensions.duckdb.org/${version}/${platform}/json.duckdb_extension.wasm`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), JSON_EXTENSION_TIMEOUT_MS);
  try {
    // Fetch asynchronously first so a slow/offline CDN can never stall boot; the synchronous INSTALL then hits the HTTP cache.
    const res = await fetch(url, { signal: ctl.signal, mode: 'cors', credentials: 'omit' });
    if (!res.ok) return 'lexical';
    await res.arrayBuffer();
  } catch {
    return 'lexical';
  } finally {
    clearTimeout(timer);
  }
  try {
    exec('INSTALL json');
    exec('LOAD json');
    const t = tableRefFromIPC(queryIPC(db(), "SELECT json_serialize_sql('SELECT 1', skip_default := true, skip_null := true, skip_empty := true) AS j", [], () => false) as Uint8Array);
    const j = String(collapseSqlResult(t, 'Slice!A1' as CellKey));
    const parsed = parseSerializedSql(j) as { error?: unknown };
    return parsed.error === false ? 'ast' : 'lexical';
  } catch {
    return 'lexical';
  }
}

function validate(sql: string, allowed: ReadonlySet<string>): SqlValidation {
  if (validator === 'lexical') return validateLexical(sql, allowed);
  const out = queryIPC(db(), 'SELECT json_serialize_sql($1::VARCHAR, skip_default := true, skip_null := true, skip_empty := true) AS j', [sql], () => false);
  if (out === 'cancelled') return { ok: false, reason: 'validation cancelled' };
  const j = collapseSqlResult(tableRefFromIPC(out), 'Slice!A1' as CellKey);
  if (typeof j !== 'string') return { ok: false, reason: 'json_serialize_sql returned no text' };
  return validateSerializedSql(parseSerializedSql(j), allowed);
}

function cancelRequested(job: Job): boolean {
  if (cancel === null || Atomics.load(cancel, 0) === 0) return false;
  if (Atomics.load(cancel, 1) === ticketOf(job.portId, job.request.requestId)) {
    Atomics.store(cancel, 0, 0);
    return true;
  }
  Atomics.store(cancel, 0, 0); // ticket mismatch: the target already finished
  return false;
}

/** Materializes bindings as temp views `__suture_b<n>`; returns names of per-request temp tables to drop. */
function bind(bindings: ReadonlyArray<WireTableBinding>): { readonly missing: ResultId[]; readonly cleanup: string[] } {
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
    exec(`CREATE OR REPLACE TEMP VIEW "${b.identifier}" AS SELECT * FROM "${source}"`);
  }
  return { missing, cleanup };
}

function unbind(bindings: ReadonlyArray<WireTableBinding>, cleanup: ReadonlyArray<string>): void {
  for (const b of bindings) exec(`DROP VIEW IF EXISTS "${b.identifier}"`);
  for (const t of cleanup) exec(`DROP TABLE IF EXISTS "${t}"`);
}

type RunOutcome = { readonly value: CellValue; readonly resultId: ResultId | null } | 'cancelled';

function runQuery(job: Job, cell: CellKey, sql: string, params: ReadonlyArray<ScalarValue>, bindings: ReadonlyArray<WireTableBinding>, scenario: number): RunOutcome {
  const allowed = new Set<string>([...datasets, ...bindings.map((b) => b.identifier)]);
  const v = validate(sql, allowed);
  if (!v.ok) return { value: makeError('#SQL!', v.reason, cell, 'sql'), resultId: null };
  try {
    // DuckDB's own Arrow IPC bytes, read chunk by chunk; the cancel flag is checked before every chunk.
    const bytes = queryIPC(db(), sql, params, () => cancelRequested(job));
    if (bytes === 'cancelled') return 'cancelled';
    const ref = tableRefFromIPC(bytes);
    const ipc = ref.ipc;
    const normalized = normalizeTable(ref, cell, 'sql');
    if (normalized.kind === 'error') return { value: normalized, resultId: null };
    const collapsed = collapseSqlResult(normalized, cell);
    if (typeof collapsed === 'object' && collapsed !== null && collapsed.kind === 'table') {
      const resultId = `r${epoch}.${job.portId}.${job.request.requestId}.${scenario}`;
      cache.set(resultId, { ipc, materialized: null, lastUse: ++useCounter });
      evictIfNeeded();
      // The cache keeps its own copy; the client receives a transferred slice (Spec 02 §4.1).
      return { value: { ...collapsed, ipc: ipc.slice() }, resultId };
    }
    return { value: collapsed, resultId: null };
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) throw e;
    return { value: makeError('#SQL!', duckdbMessage(e), cell, 'sql'), resultId: null };
  }
}

/** DuckDB errors arrive as JSON ({"exception_type": …, "exception_message": …}) or plain text. */
function duckdbMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(raw) as { exception_type?: string; exception_message?: string };
    if (typeof j.exception_message === 'string') return `${j.exception_type ?? 'Error'}: ${j.exception_message}`;
  } catch {
    // plain-text message
  }
  return raw;
}

function runBatch(job: Job, p: DuckDbQueryBatchPayload): WorkerResult {
  const shared = bind(p.shared);
  try {
    const sharedMissing = shared.missing;
    const allMissing = [...sharedMissing];
    const values: CellValue[] = [];
    const resultIds: Array<ResultId | null> = [];
    for (let i = 0; i < p.scenarios.length; i++) {
      const s = p.scenarios[i];
      if (s === undefined) continue;
      const own = bind(s.tables);
      try {
        allMissing.push(...own.missing);
        if (allMissing.length > 0) continue;
        const out = runQuery(job, p.cell, p.sql, s.params, [...p.shared, ...s.tables], i);
        if (out === 'cancelled') return { kind: 'cancelled' };
        values.push(out.value);
        resultIds.push(out.resultId);
      } finally {
        unbind(s.tables, own.cleanup);
      }
    }
    if (allMissing.length > 0) return { kind: 'missingTables', resultIds: [...new Set(allMissing)] };
    return { kind: 'values', values, resultIds };
  } finally {
    unbind(p.shared, shared.cleanup);
  }
}

async function handle(job: Job, progress: (phase: 'download' | 'compile' | 'packages' | 'bootstrap', loaded: number, total: number | null) => void): Promise<WorkerResult> {
  const r = job.request;
  switch (r.kind) {
    case 'duckdb.init': {
      cancel = r.payload.cancelBuffer === null ? null : new Int32Array(r.payload.cancelBuffer);
      const all = getJsDelivrBundles();
      // Never the COI bundle: it spawns pthread sub-workers (steering architecture §2, zero nested workers).
      const bundles = all.eh === undefined ? { mvp: all.mvp } : { mvp: all.mvp, eh: all.eh };
      const chosen = await selectBundle(bundles);
      const bundle: 'eh' | 'mvp' = all.eh !== undefined && chosen.mainModule === all.eh.mainModule ? 'eh' : 'mvp';
      progress('download', 0, null);
      const instance = await createDuckDB(bundle === 'eh' ? bundles : { mvp: all.mvp }, new VoidLogger(), BROWSER_RUNTIME);
      await instance.instantiate((p) => progress('download', p.bytesLoaded, p.bytesTotal > 0 ? p.bytesTotal : null));
      progress('bootstrap', 0, null);
      instance.open({ query: { castDecimalToDouble: true, castBigIntToDouble: false } });
      conn = instance.connect();
      for (const s of ['SET autoinstall_known_extensions = false', 'SET autoload_known_extensions = false', 'SET threads = 1', 'SET preserve_insertion_order = true', ...MACROS]) exec(s);
      epoch++;
      const version = instance.getVersion();
      validator = await chooseValidator(version.startsWith('v') ? version : `v${version}`, bundle);
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
    case 'duckdb.dropDataset':
      return { kind: 'failed', message: 'dataset registration is not part of the vertical slice (Spec 04 task 6.2)' };
    default:
      return { kind: 'failed', message: `the DuckDB worker does not handle ${r.kind}` };
  }
}

function servePeer(port: MessagePort): void {
  port.onmessage = (e: MessageEvent<unknown>) => {
    const m = e.data;
    if (!isPeerMessage(m) || m.kind !== 'peer.fetch') return;
    const tables: Array<{ resultId: ResultId; ipc: Uint8Array }> = [];
    const missing: ResultId[] = [];
    for (const id of m.resultIds) {
      const c = cache.get(id);
      if (c === undefined) missing.push(id);
      else {
        c.lastUse = ++useCounter;
        tables.push({ resultId: id, ipc: c.ipc.slice() });
      }
    }
    const reply: PeerMessage = { protocol: PROTOCOL_VERSION, kind: 'peer.tables', peerRequestId: m.peerRequestId, tables, missing };
    port.postMessage(reply, tables.map((t) => t.ipc.buffer as ArrayBuffer));
  };
}

startWorkerRuntime(handle, servePeer);
