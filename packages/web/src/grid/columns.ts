import { MAX_COLS, parseCellKey, type CellSource, type EngineId } from '@suture/core';
import { columnLayout, DEFAULT_COL_WIDTH, type ColumnLayout } from './viewport.ts';

const MIN_WIDTH = 72;
const MAX_WIDTH = 340;
const CHAR_PX = 7.2;

/**
 * The widest a label column may grow in a grid body `bodyWidth` px wide. Wide screens keep the 340 px cap; narrow
 * screens (phones) cap labels at half the body, so a label column and the value column beside it both fit and the
 * landing cell never scrolls the start of its label out of view.
 */
export function labelWidthCap(bodyWidth: number): number {
  return bodyWidth >= 2 * MAX_WIDTH ? MAX_WIDTH : Math.max(MIN_WIDTH, Math.floor(bodyWidth / 2));
}

/**
 * Column widths for one sheet: label columns grow to fit their longest literal (capped at `maxLabel`), engine columns
 * get room for their badge (`100,000 × 10 — inspect`). Computed when a sheet opens, its structure changes, or the label
 * cap changes, never while typing, so the layout does not jump under the cursor.
 */
export function sheetLayout(cells: ReadonlyArray<CellSource>, dialect: (c: CellSource) => EngineId | 'literal' | null, maxLabel: number = MAX_WIDTH): ColumnLayout {
  const want = new Map<number, number>();
  for (const c of cells) {
    const coord = parseCellKey(c.key);
    if (coord === null) continue;
    const d = dialect(c);
    const text = c.literal !== undefined ? String(c.literal ?? '') : c.raw;
    const w = d === 'sql' ? 196 : d === 'py' ? 156 : d === 'formula' ? 112 : Math.min(maxLabel, Math.ceil(text.length * CHAR_PX + 26));
    want.set(coord.col, Math.max(want.get(coord.col) ?? 0, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))));
  }
  return columnLayout(MAX_COLS, (col) => Math.max(DEFAULT_COL_WIDTH, want.get(col) ?? 0));
}
