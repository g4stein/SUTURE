import type { ExorcistProgress, ExorcistVerdict, ReplayArtifact, ReplayOutcome, SutureDocument } from '@suture/core';
import type { EngineName, IsolationInfo } from '@suture/runtime/bridge';

/** Spec 03 §6 — main thread ↔ Exorcist worker. */
export type ExorcistCommand =
  | { readonly protocol: 1; readonly kind: 'start'; readonly sessionId: number; readonly document: SutureDocument; readonly seed: number;
      readonly duckdbPort: MessagePort | null; readonly duckdbPortId: number | null;
      readonly pyodidePort: MessagePort | null; readonly pyodidePortId: number | null;
      readonly isolation: IsolationInfo; readonly interruptBuffer: SharedArrayBuffer | null; readonly duckdbCancelBuffer: SharedArrayBuffer | null }
  | { readonly protocol: 1; readonly kind: 'replay'; readonly sessionId: number; readonly document: SutureDocument; readonly artifact: ReplayArtifact;
      readonly duckdbPort: MessagePort | null; readonly duckdbPortId: number | null;
      readonly pyodidePort: MessagePort | null; readonly pyodidePortId: number | null;
      readonly isolation: IsolationInfo; readonly interruptBuffer: SharedArrayBuffer | null; readonly duckdbCancelBuffer: SharedArrayBuffer | null }
  | { readonly protocol: 1; readonly kind: 'stop'; readonly sessionId: number }
  | { readonly protocol: 1; readonly kind: 'enginePortReplaced'; readonly engine: EngineName; readonly port: MessagePort;
      readonly portId: number; readonly runningRequestId: number | null; readonly cause: 'deadline' | 'abort' | 'crash'; readonly reason: string };

export type ExorcistEvent =
  | { readonly protocol: 1; readonly kind: 'progress'; readonly sessionId: number; readonly progress: ExorcistProgress }
  | { readonly protocol: 1; readonly kind: 'verdict'; readonly sessionId: number; readonly verdict: ExorcistVerdict; readonly fragment: string | null }
  | { readonly protocol: 1; readonly kind: 'replayed'; readonly sessionId: number; readonly outcome: ReplayOutcome }
  | { readonly protocol: 1; readonly kind: 'respawnRequest'; readonly engine: EngineName; readonly portId: number; readonly requestId: number; readonly cause: 'deadline' | 'abort' }
  | { readonly protocol: 1; readonly kind: 'failure'; readonly sessionId: number; readonly message: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const portOrNull = (v: unknown): boolean => v === null || v instanceof MessagePort;
const intOrNull = (v: unknown): boolean => v === null || isInt(v);
const sabOrNull = (v: unknown): boolean => v === null || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);

export function isExorcistCommand(m: unknown): m is ExorcistCommand {
  if (!isObj(m) || m['protocol'] !== 1) return false;
  switch (m['kind']) {
    case 'start':
    case 'replay':
      return isInt(m['sessionId']) && isObj(m['document']) && (m['kind'] === 'replay' ? isObj(m['artifact']) : isInt(m['seed']))
        && portOrNull(m['duckdbPort']) && intOrNull(m['duckdbPortId']) && portOrNull(m['pyodidePort']) && intOrNull(m['pyodidePortId'])
        && isObj(m['isolation']) && sabOrNull(m['interruptBuffer']) && sabOrNull(m['duckdbCancelBuffer']);
    case 'stop':
      return isInt(m['sessionId']);
    case 'enginePortReplaced':
      return (m['engine'] === 'duckdb' || m['engine'] === 'pyodide') && m['port'] instanceof MessagePort && isInt(m['portId']) && intOrNull(m['runningRequestId']);
    default:
      return false;
  }
}

export function isExorcistEvent(m: unknown): m is ExorcistEvent {
  if (!isObj(m) || m['protocol'] !== 1) return false;
  return ['progress', 'verdict', 'replayed', 'respawnRequest', 'failure'].includes(String(m['kind']));
}
