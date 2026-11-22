import type { CellValue, EngineId } from '@suture/core';
import { formatGridNumber, formatNumber, formatValue, tableBadge } from '../app/format.ts';

export type CellKind = 'empty' | 'number' | 'text' | 'bool' | 'error' | 'pending' | 'table' | 'matrix';

export interface CellDisplay {
  readonly kind: CellKind;
  readonly text: string;
  /** Dialect chip for non-literal cells. */
  readonly chip: EngineId | null;
  /** Hover text: error diagnostics (code, message, engine, origin), or a number at full precision. */
  readonly title: string | null;
  /** Numbers only: the exact value (`String(n)`), exposed as `data-raw` for tests and tooling. */
  readonly raw: string | null;
}

export const EMPTY_DISPLAY: CellDisplay = { kind: 'empty', text: '', chip: null, title: null, raw: null };

export const CHIP_LABEL: Readonly<Record<EngineId, string>> = { formula: 'FX', sql: 'SQL', py: 'PY' };

export function cellDisplay(v: CellValue | 'pending', dialect: EngineId | 'literal' | null): CellDisplay {
  const chip = dialect === null || dialect === 'literal' ? null : dialect;
  if (v === 'pending') return { kind: 'pending', text: '…', chip, title: 'waiting for the engine', raw: null };
  if (v === null) return { kind: chip === null ? 'empty' : 'text', text: '', chip, title: null, raw: null };
  if (typeof v === 'number') return { kind: 'number', text: formatGridNumber(v), chip, title: formatNumber(v), raw: String(v) };
  if (typeof v === 'boolean') return { kind: 'bool', text: formatValue(v), chip, title: null, raw: null };
  if (typeof v === 'string') return { kind: 'text', text: v, chip, title: null, raw: null };
  if (v.kind === 'error') return { kind: 'error', text: v.code, chip, title: `${v.code} (${v.engine}) — ${v.message}${v.origin === '' ? '' : ` · origin ${v.origin}`}`, raw: null };
  if (v.kind === 'matrix') return { kind: 'matrix', text: `matrix ${v.rows}×${v.cols}`, chip, title: null, raw: null };
  return { kind: 'table', text: tableBadge(v.rowCount, v.schema.length), chip, title: `Arrow table: ${v.schema.map((f) => f.name).join(', ')}`, raw: null };
}
