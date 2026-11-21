import { describe, expect, it } from 'vitest';
import { MAX_COLS, toCellKey, type CellKey } from '@suture/core';
import { columnLayout, DEFAULT_COL_WIDTH, expandWindow, visibleWindow } from '../src/grid/viewport.ts';
import { computeXRayFrame, MAX_THREADS } from '../src/xray/edges.ts';

/** Spec 04 task 5.2 — the 1,500-thread cap, hidden count, portals, fracture flags, involvement, and flow cap. */
const layout = columnLayout(MAX_COLS, () => DEFAULT_COL_WIDTH);
const k = (sheet: string, row: number, col: number): CellKey => toCellKey({ sheet, row, col });
const U = (s: string): string => s.toUpperCase();

function graph(edges: ReadonlyArray<readonly [CellKey, CellKey]>) {
  const pre = new Map<string, CellKey[]>();
  const dep = new Map<string, CellKey[]>();
  for (const [from, to] of edges) {
    pre.set(U(to), [...(pre.get(U(to)) ?? []), from]);
    dep.set(U(from), [...(dep.get(U(from)) ?? []), to]);
  }
  return { precedents: (x: CellKey) => pre.get(U(x)) ?? [], dependents: (x: CellKey) => dep.get(U(x)) ?? [] };
}

describe('computeXRayFrame', () => {
  const win = visibleWindow(0, 0, 1200, 700, 1_048_576, layout);
  const base = { window: win, expanded: expandWindow(win, 1_048_576, MAX_COLS), layout, engineOf: () => 'formula' as const };

  it('a 10,000-edge sheet yields at most 1,500 threads and reports the rest as hidden', () => {
    // 100 sources in column A, each feeding 100 dependents in columns B..CW of the same 100 rows.
    const edges: Array<readonly [CellKey, CellKey]> = [];
    for (let r = 0; r < 100; r++) for (let c = 1; c <= 100; c++) edges.push([k('S', r, 0), k('S', r, c)]);
    const g = graph(edges);
    const cells = [...new Set(edges.flat())];
    const f = computeXRayFrame({ ...base, sheet: 'S', cells, ...g, selection: k('S', 0, 0), lineage: null });
    expect(f.threads.length).toBeLessThanOrEqual(MAX_THREADS);
    expect(f.threads.length + f.hidden).toBeGreaterThan(MAX_THREADS);
    expect(f.threads.every((t) => U(t.edge.from) === U(k('S', 0, 0)))).toBe(true); // only selection-touching survive the cap
    expect(f.threads.filter((t) => t.flow).length).toBeLessThanOrEqual(64);
  });

  it('marks lineage edges fractured, the failing edge broken, and dims everything off the lineage', () => {
    const a = k('Inputs', 1, 1);
    const b = k('Model', 3, 1);
    const c = k('Model', 4, 1);
    const d = k('Model', 6, 1);
    const g = graph([[a, b], [b, c], [c, d]]);
    const f = computeXRayFrame({
      ...base, sheet: 'Model', cells: [b, c, d], ...g, selection: d,
      lineage: { cells: [a, b, c], edges: [{ from: a, to: b }, { from: b, to: c }], failingEdge: { from: b, to: c } },
    });
    const bc = f.threads.find((t) => U(t.edge.from) === U(b) && U(t.edge.to) === U(c));
    expect(bc?.fractured).toBe(true);
    expect(bc?.broken).not.toBeNull();
    const cd = f.threads.find((t) => U(t.edge.to) === U(d));
    expect(cd?.fractured).toBe(false);
    expect([...f.involved].sort()).toEqual([U(a), U(b), U(c)].sort());
    expect(f.portals).toEqual([{ sheet: 'Inputs', direction: 'in', count: 1, engine: 'formula', target: a, fractured: true }]);
    expect(f.stubs.some((s) => s.fractured && s.direction === 'in')).toBe(true);
  });

  it('without a lineage, dims to the selection neighbourhood; without selection edges, to all connected cells', () => {
    const a = k('S', 0, 0);
    const b = k('S', 0, 1);
    const c = k('S', 5, 3);
    const d = k('S', 6, 3);
    const g = graph([[a, b], [c, d]]);
    const sel = computeXRayFrame({ ...base, sheet: 'S', cells: [a, b, c, d], ...g, selection: a, lineage: null });
    expect([...sel.involved].sort()).toEqual([U(a), U(b)].sort());
    const none = computeXRayFrame({ ...base, sheet: 'S', cells: [a, b, c, d], ...g, selection: k('S', 20, 20), lineage: null });
    expect([...none.involved].sort()).toEqual([U(a), U(b), U(c), U(d)].sort());
  });
});
