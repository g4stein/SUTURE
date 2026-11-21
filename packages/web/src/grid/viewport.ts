import type { CellCoord } from '@suture/core';

/**
 * Spec 04 §3 — grid virtualization math (pure; no DOM).
 *
 * Rows have a fixed height. A full 1,048,576-row sheet is 25,165,824 px, above what browsers accept for one scroll
 * container, so the body scroll range is capped at MAX_SCROLL_PX and mapped linearly onto the row range: scrolling to
 * the very bottom shows the very last row. Columns have variable widths (prefix sums) and need no scaling.
 */
export const ROW_HEIGHT = 24;
export const DEFAULT_COL_WIDTH = 96;
export const HEADER_HEIGHT = 24;
export const ROW_HEADER_WIDTH = 56;
export const MAX_SCROLL_PX = 8_000_000;
export const OVERSCAN_ROWS = 4;
export const OVERSCAN_COLS = 2;

export interface ColumnLayout {
  readonly widths: Float64Array; // per column, px
  readonly prefix: Float64Array; // prefix[i] = sum(widths[0..i-1]); length cols + 1
}

export interface VisibleWindow {
  readonly top: number; // inclusive row indices (overscan included)
  readonly bottom: number;
  readonly left: number; // inclusive col indices (overscan included)
  readonly right: number;
  /** px offset of row `top` relative to the top of the body (≤ 0): the cell layer is translated by it. */
  readonly offsetY: number;
}

export function columnLayout(cols: number, width: (col: number) => number): ColumnLayout {
  const widths = new Float64Array(cols);
  const prefix = new Float64Array(cols + 1);
  for (let c = 0; c < cols; c++) {
    const w = width(c);
    widths[c] = w;
    prefix[c + 1] = (prefix[c] ?? 0) + w;
  }
  return { widths, prefix };
}

export function totalWidth(layout: ColumnLayout): number {
  return layout.prefix[layout.prefix.length - 1] ?? 0;
}

/** Height of the scrollable body content: min(rows × ROW_HEIGHT, MAX_SCROLL_PX). */
export function bodyContentHeight(rows: number): number {
  return Math.min(rows * ROW_HEIGHT, MAX_SCROLL_PX);
}

/** How many content pixels one scroll pixel represents (≥ 1). */
export function rowScale(rows: number): number {
  return Math.max(1, (rows * ROW_HEIGHT) / MAX_SCROLL_PX);
}

/** Fractional row index at the top edge of the body for a body scroll offset. */
export function firstRowExact(scrollTop: number, rows: number, bodyHeight: number): number {
  const maxScroll = Math.max(0, bodyContentHeight(rows) - bodyHeight);
  const maxRow = Math.max(0, rows - bodyHeight / ROW_HEIGHT);
  if (maxScroll <= 0) return 0;
  const t = Math.min(1, Math.max(0, scrollTop / maxScroll));
  return t * maxRow;
}

/** Inverse of firstRowExact: the scroll offset that puts `rowExact` at the top edge of the body. */
export function scrollTopForRow(rowExact: number, rows: number, bodyHeight: number): number {
  const maxScroll = Math.max(0, bodyContentHeight(rows) - bodyHeight);
  const maxRow = Math.max(0, rows - bodyHeight / ROW_HEIGHT);
  if (maxRow <= 0) return 0;
  return (Math.min(maxRow, Math.max(0, rowExact)) / maxRow) * maxScroll;
}

/** Largest column index whose left edge is ≤ x (binary search over the prefix sums). */
export function colAt(x: number, layout: ColumnLayout): number {
  const n = layout.widths.length;
  if (n === 0) return 0;
  if (x <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((layout.prefix[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function visibleWindow(scrollTop: number, scrollLeft: number, viewportW: number, viewportH: number, rows: number, layout: ColumnLayout): VisibleWindow {
  const bodyH = Math.max(0, viewportH - HEADER_HEIGHT);
  const bodyW = Math.max(0, viewportW - ROW_HEADER_WIDTH);
  const exact = firstRowExact(scrollTop, rows, bodyH);
  const firstRow = Math.floor(exact);
  const top = Math.max(0, firstRow - OVERSCAN_ROWS);
  const bottom = Math.min(rows - 1, Math.floor(exact + bodyH / ROW_HEIGHT) + OVERSCAN_ROWS);
  const cols = layout.widths.length;
  const left = Math.max(0, colAt(scrollLeft, layout) - OVERSCAN_COLS);
  const right = Math.min(cols - 1, colAt(scrollLeft + bodyW, layout) + OVERSCAN_COLS);
  return { top, bottom, left, right, offsetY: (top - exact) * ROW_HEIGHT };
}

/** Cell rectangle in window coordinates (origin = top-left of cell (win.top, win.left)). */
export function cellRect(c: Pick<CellCoord, 'row' | 'col'>, win: Pick<VisibleWindow, 'top' | 'left'>, layout: ColumnLayout): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const x = (layout.prefix[c.col] ?? 0) - (layout.prefix[win.left] ?? 0);
  return { x, y: (c.row - win.top) * ROW_HEIGHT, w: layout.widths[c.col] ?? DEFAULT_COL_WIDTH, h: ROW_HEIGHT };
}

export function sameWindow(a: VisibleWindow | null, b: VisibleWindow): boolean {
  return a !== null && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/** The window grown by one viewport in every direction (X-Ray candidate edges, Spec 04 §5.2). */
export function expandWindow(win: VisibleWindow, rows: number, cols: number): VisibleWindow {
  const h = win.bottom - win.top + 1;
  const w = win.right - win.left + 1;
  return { top: Math.max(0, win.top - h), bottom: Math.min(rows - 1, win.bottom + h), left: Math.max(0, win.left - w), right: Math.min(cols - 1, win.right + w), offsetY: win.offsetY };
}
