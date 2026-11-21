import { decodeScalar, type CellValue, type EncodedScalar, type ValueSummary } from '@suture/core';
import type { EngineName, EngineState, EngineStatus } from '../workers/protocol.ts';

/** Up to 12 significant digits; exponent notation outside [1e-6, 1e15) (Spec 04 §3). Display never changes stored values. */
export function formatNumber(n: number): string {
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 1e-6 || a >= 1e15) return n.toExponential(6).replace(/\.?0+e/, 'e');
  return String(Number(n.toPrecision(12)));
}

export function formatValue(v: CellValue | 'pending' | undefined): string {
  if (v === undefined || v === 'pending') return '…';
  if (v === null) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (v.kind === 'error') return v.code;
  if (v.kind === 'matrix') return `matrix ${v.rows}×${v.cols}`;
  return `table ${v.rowCount.toLocaleString('en-US')}×${v.schema.length}`;
}

/** Compact badge text for a TableRef cell: `100,000 × 6`. */
export function tableBadge(rowCount: number, cols: number): string {
  return `${rowCount.toLocaleString('en-US')} × ${cols}`;
}

export function formatScalar(e: EncodedScalar): string {
  const v = decodeScalar(e);
  if (v === null) return 'blank';
  return typeof v === 'number' ? formatNumber(v) : String(v);
}

export function formatSummary(s: ValueSummary): string {
  switch (s.kind) {
    case 'scalar': return formatScalar(s.value);
    case 'error': return s.code;
    case 'matrix': return `matrix ${s.rows}×${s.cols}`;
    case 'table': return `table ${s.rowCount.toLocaleString('en-US')}×${s.columns.length}`;
  }
}

export function formatMs(v: number | null): string {
  return v === null ? '—' : `${v.toLocaleString('en-US')} ms`;
}

export const ENGINE_NAME: Readonly<Record<EngineName, string>> = { duckdb: 'DuckDB', pyodide: 'Python/NumPy' };

/** ui-craft-and-branding.md §4: internal `not loaded` is displayed as "Lazy", never once loading has begun. */
export function engineLabel(s: EngineStatus): string {
  const labels: Readonly<Record<EngineState, string>> = { notLoaded: 'Lazy', loading: 'Loading', ready: 'Ready', degraded: 'Degraded', failed: 'Failed' };
  if (s.state === 'loading' && s.progress !== null && s.progress.totalBytes !== null && s.progress.totalBytes > 0) {
    return `Loading ${Math.min(99, Math.floor((100 * s.progress.loadedBytes) / s.progress.totalBytes))}%`;
  }
  if (s.state === 'degraded') return 'Degraded (restart on timeout)';
  return labels[s.state];
}

/** Spec 04 Req 4.1 (colon form): `DuckDB: Ready`, `Python/NumPy: Lazy`. */
export function pillText(s: EngineStatus): string {
  return `${ENGINE_NAME[s.engine]}: ${engineLabel(s)}`;
}

/** Accessible name: label plus the full reason, prefixed with the engine (steering §4 wording). */
export function pillAccessibleName(s: EngineStatus): string {
  return s.reason === null ? pillText(s) : `${pillText(s)}. ${ENGINE_NAME[s.engine]}: ${s.reason}`;
}
