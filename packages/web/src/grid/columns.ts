import { MAX_COLS, parseCellKey, type CellSource, type EngineId } from '@suture/core';
import { columnLayout, DEFAULT_COL_WIDTH, type ColumnLayout } from './viewport.ts';

const MIN_WIDTH = 72;
const MAX_WIDTH = 340;
const CHAR_PX = 7.2;

/**
 * Column widths for one sheet: label columns grow to fit their longest literal (capped), engine columns get room for
 * their badge (`100,000 × 10 — inspect`). Computed when a sheet opens or its structure changes, never while typing,
 * so the layout does not jump under the cursor.
 */
export function sheetLayout(cells: ReadonlyArray<CellSource>, dialect: (c: CellSource) => EngineId | 'literal' | null): ColumnLayout {
  const want = new Map<number, number>();
  for (const c of cells) {
    const coord = parseCellKey(c.key);
    if (coord === null) continue;
    const d = dialect(c);
    const text = c.literal !== undefined ? String(c.literal ?? '') : c.raw;
    const w = d === 'sql' ? 196 : d === 'py' ? 156 : d === 'formula' ? 112 : Math.ceil(text.length * CHAR_PX + 26);
    want.set(coord.col, Math.max(want.get(coord.col) ?? 0, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))));
  }
  return columnLayout(MAX_COLS, (col) => Math.max(DEFAULT_COL_WIDTH, want.get(col) ?? 0));
}
