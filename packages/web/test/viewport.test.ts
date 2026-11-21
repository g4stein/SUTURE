import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_COLS, MAX_ROWS } from '@suture/core';
import {
  bodyContentHeight, cellRect, colAt, columnLayout, DEFAULT_COL_WIDTH, firstRowExact, MAX_SCROLL_PX, OVERSCAN_COLS, OVERSCAN_ROWS, ROW_HEIGHT,
  scrollTopForRow, totalWidth, visibleWindow,
} from '../src/grid/viewport.ts';

/** Spec 04 task 2.1 — virtualization math. */
const layout = columnLayout(MAX_COLS, (c) => (c === 0 ? 220 : DEFAULT_COL_WIDTH));

describe('grid/viewport', () => {
  it('caps the scroll extent at 8,000,000 px for a full sheet', () => {
    expect(bodyContentHeight(MAX_ROWS)).toBe(MAX_SCROLL_PX);
    expect(bodyContentHeight(100)).toBe(100 * ROW_HEIGHT);
  });

  it('makes row 1,048,576 reachable at maximum scroll', () => {
    const bodyH = 600;
    const maxScroll = bodyContentHeight(MAX_ROWS) - bodyH;
    const exact = firstRowExact(maxScroll, MAX_ROWS, bodyH);
    const last = Math.floor(exact + bodyH / ROW_HEIGHT) - 1;
    expect(last).toBe(MAX_ROWS - 1);
    const w = visibleWindow(maxScroll, 0, 1200, bodyH + 24, MAX_ROWS, layout);
    expect(w.bottom).toBe(MAX_ROWS - 1);
  });

  it('scrollTopForRow inverts firstRowExact', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: MAX_ROWS - 30 }), (row) => {
      const bodyH = 600;
      expect(Math.abs(firstRowExact(scrollTopForRow(row, MAX_ROWS, bodyH), MAX_ROWS, bodyH) - row)).toBeLessThan(1e-6);
    }), { seed: 42, numRuns: 300 });
  });

  it('includes exactly 4 rows and 2 columns of overscan, clamped at the sheet edges', () => {
    const w0 = visibleWindow(0, 0, 1056, 624, MAX_ROWS, layout);
    expect(w0.top).toBe(0);
    expect(w0.left).toBe(0);
    expect(w0.bottom).toBe(Math.floor(600 / ROW_HEIGHT) + OVERSCAN_ROWS);
    const mid = visibleWindow(scrollTopForRow(500, MAX_ROWS, 600), 220 + 96 * 50, 1056, 624, MAX_ROWS, layout);
    expect(mid.top).toBe(500 - OVERSCAN_ROWS);
    expect(mid.left).toBe(51 - OVERSCAN_COLS);
  });

  it('colAt finds the column at width boundaries', () => {
    expect(colAt(0, layout)).toBe(0);
    expect(colAt(219.9, layout)).toBe(0);
    expect(colAt(220, layout)).toBe(1);
    expect(colAt(220 + 96, layout)).toBe(2);
    expect(colAt(totalWidth(layout) + 1e6, layout)).toBe(MAX_COLS - 1);
  });

  it('cellRect places cells in window coordinates', () => {
    const w = { top: 10, left: 1 };
    expect(cellRect({ row: 12, col: 3 }, w, layout)).toEqual({ x: 192, y: 48, w: 96, h: 24 });
  });
});
