import type { EngineName, EngineState, EngineStatus } from '@suture/runtime/bridge';

import { formatNumber } from '@suture/runtime/headless';

/** Value display is shared with the CLI and the MCP server, so every host prints numbers the same way (Spec 04 §3). */
export { formatNumber, formatScalar, formatSummary, formatValue, tableBadge } from '@suture/runtime/headless';

const GRID_LARGE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: true });
const GRID_SMALL = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4, useGrouping: true });

/**
 * Grid cells only (Spec 04 Req 1.4): thousand separators, at most 2 decimals when |n| ≥ 1, 4 significant digits when
 * |n| < 1, and the shared exponent form outside [1e-6, 1e15). The tooltip, inspector, formula bar, X-Ray callouts,
 * Audit Studio, and every stored value keep full precision.
 */
export function formatGridNumber(n: number): string {
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 1e-6 || a >= 1e15) return formatNumber(n);
  return (a >= 1 ? GRID_LARGE : GRID_SMALL).format(n);
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
