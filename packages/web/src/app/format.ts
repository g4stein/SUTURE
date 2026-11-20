import { decodeScalar, type CellValue, type EncodedScalar } from '@suture/core';
import type { EngineState, EngineStatus } from '../workers/protocol.ts';

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

export function formatScalar(e: EncodedScalar): string {
  const v = decodeScalar(e);
  return typeof v === 'number' ? formatNumber(v) : String(v);
}

/** ui-craft-and-branding.md §4: internal `not loaded` is displayed as "Lazy", never once loading has begun. */
export function engineLabel(s: EngineStatus): string {
  const labels: Readonly<Record<EngineState, string>> = { notLoaded: 'Lazy', loading: 'Loading', ready: 'Ready', degraded: 'Degraded', failed: 'Failed' };
  if (s.state === 'loading' && s.progress !== null && s.progress.totalBytes !== null && s.progress.totalBytes > 0) {
    return `Loading ${Math.min(99, Math.floor((100 * s.progress.loadedBytes) / s.progress.totalBytes))}%`;
  }
  if (s.state === 'degraded') return 'Degraded (restart on timeout)';
  return labels[s.state];
}
