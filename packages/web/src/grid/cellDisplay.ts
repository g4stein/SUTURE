import type { CellValue, EngineId } from '@suture/core';
import { formatValue, tableBadge } from '../app/format.ts';

export type CellKind = 'empty' | 'number' | 'text' | 'bool' | 'error' | 'pending' | 'table' | 'matrix';

export interface CellDisplay {
  readonly kind: CellKind;
  readonly text: string;
  /** Dialect chip for non-literal cells. */
  readonly chip: EngineId | null;
  /** Hover diagnostics for errors: code, message, engine, origin. */
  readonly title: string | null;
}

export const EMPTY_DISPLAY: CellDisplay = { kind: 'empty', text: '', chip: null, title: null };

export const CHIP_LABEL: Readonly<Record<EngineId, string>> = { formula: 'FX', sql: 'SQL', py: 'PY' };

export function cellDisplay(v: CellValue | 'pending', dialect: EngineId | 'literal' | null): CellDisplay {
  const chip = dialect === null || dialect === 'literal' ? null : dialect;
  if (v === 'pending') return { kind: 'pending', text: '…', chip, title: 'waiting for the engine' };
  if (v === null) return { kind: chip === null ? 'empty' : 'text', text: '', chip, title: null };
  if (typeof v === 'number') return { kind: 'number', text: formatValue(v), chip, title: null };
  if (typeof v === 'boolean') return { kind: 'bool', text: formatValue(v), chip, title: null };
  if (typeof v === 'string') return { kind: 'text', text: v, chip, title: null };
  if (v.kind === 'error') return { kind: 'error', text: v.code, chip, title: `${v.code} (${v.engine}) — ${v.message}${v.origin === '' ? '' : ` · origin ${v.origin}`}` };
  if (v.kind === 'matrix') return { kind: 'matrix', text: `matrix ${v.rows}×${v.cols}`, chip, title: null };
  return { kind: 'table', text: tableBadge(v.rowCount, v.schema.length), chip, title: `Arrow table: ${v.schema.map((f) => f.name).join(', ')}` };
}
