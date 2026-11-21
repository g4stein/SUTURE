import type { ArrowField, CellKey, CellValue, DatasetMeta, Matrix2D, RangeSnapshot, ScalarValue, TableRef } from '@suture/core';
import type { IsolationInfo } from './isolation.ts';

/** Spec 02 §3 — the single message contract between clients and engine workers. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type WorkerKind = 'duckdb' | 'pyodide' | 'ingest';
export type Priority = 'interactive' | 'background';
/** "r<epoch>.<portId>.<requestId>.<scenarioIndex>" — unique for a DuckDB worker instance. */
export type ResultId = string;

interface RequestBase<K extends string, P> {
  readonly protocol: ProtocolVersion;
  readonly requestId: number;
  readonly generation: number | null;
  readonly kind: K;
  readonly priority: Priority;
  readonly deadlineMs: number;
  readonly payload: P;
}

export interface DuckDbInitPayload {
  readonly isolation: IsolationInfo;
  readonly cancelBuffer: SharedArrayBuffer | null;
}

export interface RegisterDatasetPayload {
  readonly name: string;
  readonly sourceFormat: 'csv' | 'parquet' | 'xlsx';
  readonly encoding: 'csv' | 'parquet' | 'arrow';
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export type WireTableSource =
  | { readonly kind: 'result'; readonly resultId: ResultId }
  | { readonly kind: 'ipc'; readonly table: TableRef };

export interface WireTableBinding {
  readonly identifier: string;
  readonly source: WireTableSource;
}

export interface DuckDbQueryPayload {
  readonly cell: CellKey;
  readonly sql: string;
  readonly params: ReadonlyArray<ScalarValue>;
  readonly tables: ReadonlyArray<WireTableBinding>;
}

export interface DuckDbQueryBatchPayload {
  readonly cell: CellKey;
  readonly sql: string;
  readonly shared: ReadonlyArray<WireTableBinding>;
  readonly scenarios: ReadonlyArray<{
    readonly params: ReadonlyArray<ScalarValue>;
    readonly tables: ReadonlyArray<WireTableBinding>;
  }>;
}

export type DuckDbRequest =
  | RequestBase<'duckdb.init', DuckDbInitPayload>
  | RequestBase<'duckdb.registerDataset', RegisterDatasetPayload>
  | RequestBase<'duckdb.dropDataset', { readonly name: string }>
  | RequestBase<'duckdb.query', DuckDbQueryPayload>
  | RequestBase<'duckdb.queryBatch', DuckDbQueryBatchPayload>
  | RequestBase<'duckdb.releaseResults', { readonly resultIds: ReadonlyArray<ResultId> }>;

export interface PyInitPayload {
  readonly isolation: IsolationInfo;
  readonly interruptBuffer: SharedArrayBuffer | null;
}

export type WirePyValue =
  | { readonly kind: 'scalar'; readonly value: ScalarValue }
  | { readonly kind: 'matrix'; readonly value: Matrix2D }
  | { readonly kind: 'table'; readonly source: WireTableSource; readonly schema: ReadonlyArray<ArrowField>; readonly rowCount: number }
  | { readonly kind: 'range'; readonly value: RangeSnapshot };

export interface WirePyBinding {
  readonly key: string;
  readonly value: WirePyValue;
}

export interface PyRunPayload {
  readonly cell: CellKey;
  readonly code: string;
  readonly vectorized: boolean;
  readonly seed: number;
  readonly inputs: ReadonlyArray<WirePyBinding>;
}

export interface PyRunBatchPayload {
  readonly cell: CellKey;
  readonly code: string;
  readonly vectorized: boolean;
  readonly seed: number;
  readonly shared: ReadonlyArray<WirePyBinding>;
  readonly scenarios: ReadonlyArray<ReadonlyArray<WirePyBinding>>;
}

export type PyRequest =
  | RequestBase<'py.init', PyInitPayload>
  | RequestBase<'py.run', PyRunPayload>
  | RequestBase<'py.runBatch', PyRunBatchPayload>;

export interface XlsxIngestResult {
  readonly sheets: ReadonlyArray<{
    readonly name: string;
    readonly cells: ReadonlyArray<{ readonly row: number; readonly col: number; readonly raw: string }>;
  }>;
  readonly tables: ReadonlyArray<{ readonly sheet: string; readonly ipc: Uint8Array; readonly header: 'firstRow' | 'columnLetters' }>;
  readonly warnings: ReadonlyArray<string>;
}

export type IngestRequest = RequestBase<'ingest.xlsx', { readonly fileName: string; readonly bytes: Uint8Array }>;

export type WorkerRequest = DuckDbRequest | PyRequest | IngestRequest;
export type RequestKind = WorkerRequest['kind'];
export type PayloadOf<K extends RequestKind> = Extract<WorkerRequest, { kind: K }>['payload'];

export type WorkerResult =
  | { readonly kind: 'duckdb.ready'; readonly bundle: 'eh' | 'mvp'; readonly duckdbVersion: string; readonly validator: 'ast' | 'lexical' }
  | { readonly kind: 'py.ready'; readonly pyodideVersion: string; readonly numpyVersion: string; readonly interrupt: boolean }
  | { readonly kind: 'dataset'; readonly meta: DatasetMeta; readonly preview: TableRef }
  | { readonly kind: 'ack' }
  | { readonly kind: 'value'; readonly value: CellValue; readonly resultId: ResultId | null }
  | { readonly kind: 'values'; readonly values: ReadonlyArray<CellValue>; readonly resultIds: ReadonlyArray<ResultId | null> }
  | { readonly kind: 'missingTables'; readonly resultIds: ReadonlyArray<ResultId> }
  | { readonly kind: 'xlsx'; readonly workbook: XlsxIngestResult }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' };

export type LoadPhase = 'download' | 'compile' | 'packages' | 'bootstrap';

export type WorkerResponse =
  | { readonly protocol: ProtocolVersion; readonly kind: 'result'; readonly requestId: number; readonly result: WorkerResult }
  | { readonly protocol: ProtocolVersion; readonly kind: 'started'; readonly requestId: number }
  | { readonly protocol: ProtocolVersion; readonly kind: 'progress'; readonly requestId: number; readonly phase: LoadPhase; readonly loadedBytes: number; readonly totalBytes: number | null }
  | { readonly protocol: ProtocolVersion; readonly kind: 'protocolError'; readonly requestId: number | null; readonly reason: string };

export type ControlMessage =
  | { readonly protocol: ProtocolVersion; readonly kind: 'cancel'; readonly requestId: number }
  | { readonly protocol: ProtocolVersion; readonly kind: 'attachPort'; readonly portId: number; readonly role: 'client' | 'peer'; readonly port: MessagePort };

export type HostEvent =
  | { readonly protocol: ProtocolVersion; readonly kind: 'jobStarted'; readonly portId: number; readonly requestId: number }
  | { readonly protocol: ProtocolVersion; readonly kind: 'jobFinished'; readonly portId: number; readonly requestId: number }
  | { readonly protocol: ProtocolVersion; readonly kind: 'fatal'; readonly reason: string };

export type PeerMessage =
  | { readonly protocol: ProtocolVersion; readonly kind: 'peer.fetch'; readonly peerRequestId: number; readonly resultIds: ReadonlyArray<ResultId> }
  | { readonly protocol: ProtocolVersion; readonly kind: 'peer.tables'; readonly peerRequestId: number; readonly tables: ReadonlyArray<{ readonly resultId: ResultId; readonly ipc: Uint8Array }>; readonly missing: ReadonlyArray<ResultId> };

export type EngineName = 'duckdb' | 'pyodide';
export type EngineState = 'notLoaded' | 'loading' | 'ready' | 'degraded' | 'failed';

export interface EngineStatus {
  readonly engine: EngineName;
  readonly state: EngineState;
  readonly progress: { readonly loadedBytes: number; readonly totalBytes: number | null } | null;
  readonly reason: string | null;
  readonly crashCount: number;
}

// ------------------------------------------------------------------ guards (input is untrusted `unknown`)

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isScalar = (v: unknown): v is ScalarValue => v === null || isStr(v) || isBool(v) || (typeof v === 'number' && Number.isFinite(v));
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const isPort = (v: unknown): v is MessagePort => typeof MessagePort !== 'undefined' && v instanceof MessagePort;
const isSab = (v: unknown): v is SharedArrayBuffer => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer;

function isField(v: unknown): v is ArrowField {
  return isObj(v) && isStr(v['name']) && isStr(v['arrowType']) && isBool(v['nullable']);
}
function isTableRef(v: unknown): v is TableRef {
  return isObj(v) && v['kind'] === 'table' && isBytes(v['ipc']) && Array.isArray(v['schema']) && v['schema'].every(isField) && isInt(v['rowCount']);
}
function isMatrix(v: unknown): v is Matrix2D {
  return isObj(v) && v['kind'] === 'matrix' && isInt(v['rows']) && isInt(v['cols']) && v['data'] instanceof Float64Array;
}
function isCellErrorShape(v: unknown): boolean {
  return isObj(v) && v['kind'] === 'error' && isStr(v['code']) && isStr(v['message']) && isStr(v['origin']) && isStr(v['engine']);
}
export function isCellValue(v: unknown): v is CellValue {
  return isScalar(v) || isTableRef(v) || isMatrix(v) || isCellErrorShape(v);
}
function isIsolation(v: unknown): v is IsolationInfo {
  return isObj(v) && isBool(v['crossOriginIsolated']) && isBool(v['sharedArrayBuffer']);
}
function isTableSource(v: unknown): v is WireTableSource {
  if (!isObj(v)) return false;
  if (v['kind'] === 'result') return isStr(v['resultId']);
  if (v['kind'] === 'ipc') return isTableRef(v['table']);
  return false;
}
function isTableBinding(v: unknown): v is WireTableBinding {
  return isObj(v) && isStr(v['identifier']) && /^__suture_b\d+$/.test(v['identifier']) && isTableSource(v['source']);
}
function isRange(v: unknown): v is RangeSnapshot {
  return isObj(v) && v['kind'] === 'range' && isInt(v['rows']) && isInt(v['cols']) && Array.isArray(v['values']) && v['values'].every(isScalar);
}
function isPyValue(v: unknown): v is WirePyValue {
  if (!isObj(v)) return false;
  switch (v['kind']) {
    case 'scalar': return isScalar(v['value']);
    case 'matrix': return isMatrix(v['value']);
    case 'table': return isTableSource(v['source']) && Array.isArray(v['schema']) && v['schema'].every(isField) && isInt(v['rowCount']);
    case 'range': return isRange(v['value']);
    default: return false;
  }
}
function isPyBinding(v: unknown): v is WirePyBinding {
  return isObj(v) && isStr(v['key']) && isPyValue(v['value']);
}
const arr = <T>(v: unknown, g: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(g);

function payloadOk(kind: string, p: unknown): boolean {
  if (!isObj(p)) return false;
  switch (kind) {
    case 'duckdb.init': return isIsolation(p['isolation']) && (p['cancelBuffer'] === null || isSab(p['cancelBuffer']));
    case 'duckdb.registerDataset': return isStr(p['name']) && isStr(p['sourceFormat']) && isStr(p['encoding']) && isBytes(p['bytes']) && isStr(p['sha256']);
    case 'duckdb.dropDataset': return isStr(p['name']);
    case 'duckdb.query': return isStr(p['cell']) && isStr(p['sql']) && arr(p['params'], isScalar) && arr(p['tables'], isTableBinding);
    case 'duckdb.queryBatch':
      return isStr(p['cell']) && isStr(p['sql']) && arr(p['shared'], isTableBinding) && Array.isArray(p['scenarios'])
        && p['scenarios'].every((s) => isObj(s) && arr(s['params'], isScalar) && arr(s['tables'], isTableBinding));
    case 'duckdb.releaseResults': return arr(p['resultIds'], isStr);
    case 'py.init': return isIsolation(p['isolation']) && (p['interruptBuffer'] === null || isSab(p['interruptBuffer']));
    case 'py.run': return isStr(p['cell']) && isStr(p['code']) && isBool(p['vectorized']) && isInt(p['seed']) && arr(p['inputs'], isPyBinding);
    case 'py.runBatch':
      return isStr(p['cell']) && isStr(p['code']) && isBool(p['vectorized']) && isInt(p['seed']) && arr(p['shared'], isPyBinding)
        && Array.isArray(p['scenarios']) && p['scenarios'].every((s) => arr(s, isPyBinding));
    case 'ingest.xlsx': return isStr(p['fileName']) && isBytes(p['bytes']);
    default: return false;
  }
}

export function isWorkerRequest(m: unknown): m is WorkerRequest {
  return isObj(m) && m['protocol'] === PROTOCOL_VERSION && isInt(m['requestId']) && (m['generation'] === null || isInt(m['generation']))
    && isStr(m['kind']) && (m['priority'] === 'interactive' || m['priority'] === 'background') && isInt(m['deadlineMs'])
    && payloadOk(m['kind'], m['payload']);
}

function isResult(r: unknown): r is WorkerResult {
  if (!isObj(r)) return false;
  switch (r['kind']) {
    case 'duckdb.ready': return (r['bundle'] === 'eh' || r['bundle'] === 'mvp') && isStr(r['duckdbVersion']) && (r['validator'] === 'ast' || r['validator'] === 'lexical');
    case 'py.ready': return isStr(r['pyodideVersion']) && isStr(r['numpyVersion']) && isBool(r['interrupt']);
    case 'dataset': return isObj(r['meta']) && isTableRef(r['preview']);
    case 'ack': case 'cancelled': return true;
    case 'value': return isCellValue(r['value']) && (r['resultId'] === null || isStr(r['resultId']));
    case 'values': return arr(r['values'], isCellValue) && Array.isArray(r['resultIds']);
    case 'missingTables': return arr(r['resultIds'], isStr);
    case 'xlsx': return isObj(r['workbook']);
    case 'failed': return isStr(r['message']);
    default: return false;
  }
}

export function isWorkerResponse(m: unknown): m is WorkerResponse {
  if (!isObj(m) || m['protocol'] !== PROTOCOL_VERSION) return false;
  switch (m['kind']) {
    case 'result': return isInt(m['requestId']) && isResult(m['result']);
    case 'started': return isInt(m['requestId']);
    case 'progress': return isInt(m['requestId']) && isStr(m['phase']) && typeof m['loadedBytes'] === 'number';
    case 'protocolError': return (m['requestId'] === null || isInt(m['requestId'])) && isStr(m['reason']);
    default: return false;
  }
}

export function isControlMessage(m: unknown): m is ControlMessage {
  if (!isObj(m) || m['protocol'] !== PROTOCOL_VERSION) return false;
  if (m['kind'] === 'cancel') return isInt(m['requestId']);
  if (m['kind'] === 'attachPort') return isInt(m['portId']) && (m['role'] === 'client' || m['role'] === 'peer') && isPort(m['port']);
  return false;
}

export function isHostEvent(m: unknown): m is HostEvent {
  if (!isObj(m) || m['protocol'] !== PROTOCOL_VERSION) return false;
  if (m['kind'] === 'jobStarted' || m['kind'] === 'jobFinished') return isInt(m['portId']) && isInt(m['requestId']);
  if (m['kind'] === 'fatal') return isStr(m['reason']);
  return false;
}

export function isPeerMessage(m: unknown): m is PeerMessage {
  if (!isObj(m) || m['protocol'] !== PROTOCOL_VERSION) return false;
  if (m['kind'] === 'peer.fetch') return isInt(m['peerRequestId']) && arr(m['resultIds'], isStr);
  if (m['kind'] === 'peer.tables') {
    return isInt(m['peerRequestId']) && Array.isArray(m['tables']) && m['tables'].every((t) => isObj(t) && isStr(t['resultId']) && isBytes(t['ipc'])) && arr(m['missing'], isStr);
  }
  return false;
}

// ------------------------------------------------------------------ buffer ownership (Spec 02 §4.1)

export function owned(view: Uint8Array): Uint8Array {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
}

export function ownedF64(view: Float64Array): Float64Array {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
}

function collect(v: unknown, out: Set<ArrayBuffer>, depth: number): void {
  if (depth > 8 || v === null || typeof v !== 'object') return;
  if (v instanceof Uint8Array || v instanceof Float64Array) {
    if (v.buffer instanceof ArrayBuffer && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) out.add(v.buffer);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out, depth + 1);
    return;
  }
  for (const x of Object.values(v)) collect(x, out, depth + 1);
}

/** Every whole-buffer ArrayBuffer carried in `bytes`, `ipc`, or `Matrix2D.data` fields. */
export function transferListOf(m: WorkerRequest | WorkerResponse | PeerMessage): Transferable[] {
  const s = new Set<ArrayBuffer>();
  collect(m, s, 0);
  return [...s];
}
