import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { columnLetters, decodeScalar, MAX_COLS, MAX_ROWS, parseCellKey, toCellKey, type CellKey, type EngineId } from '@suture/core';
import type { AppSnapshot, AppStore } from '../app/store.ts';
import { formatSummary, formatValue } from '../app/format.ts';
import { sheetLayout } from './columns.ts';
import { cellDisplay, CHIP_LABEL, EMPTY_DISPLAY } from './cellDisplay.ts';
import { CellView, ENGINE_BORDER, ENGINE_TEXT } from './CellView.tsx';
import {
  bodyContentHeight, cellRect, colAt, expandWindow, firstRowExact, HEADER_HEIGHT, ROW_HEADER_WIDTH, ROW_HEIGHT, scrollTopForRow, totalWidth, visibleWindow,
  type ColumnLayout, type VisibleWindow,
} from './viewport.ts';
import { computeXRayFrame, type XRayFrame } from '../xray/edges.ts';
import { XRayOverlay } from '../xray/XRayOverlay.tsx';

const ROWS = MAX_ROWS;
const COLS = MAX_COLS;
const U = (k: string): string => k.toUpperCase();

function contains(cur: VisibleWindow, top: number, bottom: number, left: number, right: number): boolean {
  return cur.top <= top && cur.bottom >= Math.min(ROWS - 1, bottom) && cur.left <= left && cur.right >= Math.min(COLS - 1, right);
}

interface Callout { readonly key: CellKey; readonly x: number; readonly y: number; readonly text: string; readonly tone: 'input' | 'engine' | 'violated' }

/**
 * Spec 04 §3 — virtualized grid. A sticky viewport layer holds three translated layers (column header, row header,
 * body). Scrolling only rewrites their transforms; React re-renders when the visible range leaves the rendered window
 * (visible cells plus 4 rows / 2 columns of overscan). The X-Ray overlay lives in the body layer in window coordinates,
 * so its geometry is recomputed only when the window, layout, graph, selection, or lineage changes (Req 5.8).
 */
export function Grid({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const sheet = snap.activeSheet;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const colHeadRef = useRef<HTMLDivElement>(null);
  const rowHeadRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 520 });
  // Recomputed on sheet switch and structural change only, never while typing.
  const layout: ColumnLayout = useMemo(() => sheetLayout(store.cellsOn(sheet), (c) => store.dialect(c.key)), [store, sheet, snap.structureVersion]);
  const [win, setWin] = useState<VisibleWindow>(() => visibleWindow(0, 0, 960, 520, ROWS, layout));
  const winRef = useRef(win);
  winRef.current = win;

  const applyTransforms = useCallback((w: VisibleWindow) => {
    const el = scrollRef.current;
    if (el === null) return;
    const bodyH = Math.max(0, size.h - HEADER_HEIGHT);
    const exact = firstRowExact(el.scrollTop, ROWS, bodyH);
    const dy = (w.top - exact) * ROW_HEIGHT;
    const dx = (layout.prefix[w.left] ?? 0) - el.scrollLeft;
    if (bodyRef.current !== null) bodyRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    if (colHeadRef.current !== null) colHeadRef.current.style.transform = `translate3d(${dx}px, 0, 0)`;
    if (rowHeadRef.current !== null) rowHeadRef.current.style.transform = `translate3d(0, ${dy}px, 0)`;
  }, [size, layout]);

  const sync = useCallback((force: boolean) => {
    const el = scrollRef.current;
    if (el === null) return;
    const bodyH = Math.max(0, size.h - HEADER_HEIGHT);
    const bodyW = Math.max(0, size.w - ROW_HEADER_WIDTH);
    const exact = firstRowExact(el.scrollTop, ROWS, bodyH);
    const first = Math.floor(exact);
    const last = Math.floor(exact + bodyH / ROW_HEIGHT);
    const c0 = colAt(el.scrollLeft, layout);
    const c1 = colAt(el.scrollLeft + bodyW, layout);
    const cur = winRef.current;
    if (force || !contains(cur, first, last, c0, c1)) {
      const next = visibleWindow(el.scrollTop, el.scrollLeft, size.w, size.h, ROWS, layout);
      winRef.current = next;
      flushSync(() => setWin(next));
    }
    applyTransforms(winRef.current);
  }, [size, layout, applyTransforms]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => sync(false);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [sync]);

  // Sheet switch: back to the top-left. Size or layout change: re-derive the window.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null) { el.scrollTop = 0; el.scrollLeft = 0; }
  }, [sheet]);
  useLayoutEffect(() => { sync(true); }, [sync, sheet]);
  useLayoutEffect(() => { applyTransforms(win); }, [win, applyTransforms]);

  // Keep the selection in view (keyboard navigation, name box, lineage jumps).
  const sel = parseCellKey(snap.selection);
  const selRow = sel?.row ?? 0;
  const selCol = sel?.col ?? 0;
  const selOnSheet = sel !== null && sel.sheet.toUpperCase() === sheet.toUpperCase();
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !selOnSheet) return;
    const bodyH = Math.max(0, size.h - HEADER_HEIGHT);
    const bodyW = Math.max(0, size.w - ROW_HEADER_WIDTH);
    const exact = firstRowExact(el.scrollTop, ROWS, bodyH);
    const rowsVisible = bodyH / ROW_HEIGHT;
    if (selRow < exact) el.scrollTop = scrollTopForRow(selRow, ROWS, bodyH);
    else if (selRow + 1 > exact + rowsVisible - 0.01) el.scrollTop = scrollTopForRow(selRow + 1 - rowsVisible, ROWS, bodyH);
    const x0 = layout.prefix[selCol] ?? 0;
    const x1 = layout.prefix[selCol + 1] ?? x0;
    if (x0 < el.scrollLeft) el.scrollLeft = x0;
    else if (x1 > el.scrollLeft + bodyW) el.scrollLeft = x1 - bodyW;
  }, [selOnSheet, size, layout, selRow, selCol]);

  // ------------------------------------------------------------------ X-Ray frame (memoized, Req 5.8)
  const lineage = snap.focus?.lineage ?? null;
  // Counts recomputations; rendered as data-frame-id so tests can prove scrolling inside the window reuses the frame.
  const frameSeq = useRef(0);
  const frame: XRayFrame | null = useMemo(() => {
    if (!snap.xray) return null;
    frameSeq.current++;
    const engineOf = (k: CellKey): EngineId => { const d = store.dialect(k); return d === 'sql' || d === 'py' ? d : 'formula'; };
    return computeXRayFrame({
      sheet, cells: store.cellsOn(sheet).map((c) => c.key), precedents: (k) => store.precedents(k), dependents: (k) => store.dependents(k), engineOf,
      window: win, expanded: expandWindow(win, ROWS, COLS), layout, selection: snap.selection, lineage,
    });
  }, [snap.xray, sheet, win, layout, snap.editVersion, snap.selection, lineage, store]);

  const lineageSet = useMemo(() => new Set((lineage?.cells ?? []).map(U)), [lineage]);

  // ------------------------------------------------------------------ cells in the window
  const rows = useMemo(() => {
    const out: Array<{ r: number; cells: Array<{ key: CellKey; col: number; x: number; w: number }> }> = [];
    const base = layout.prefix[win.left] ?? 0;
    for (let r = win.top; r <= win.bottom; r++) {
      const cells: Array<{ key: CellKey; col: number; x: number; w: number }> = [];
      for (let c = win.left; c <= win.right; c++) cells.push({ key: toCellKey({ sheet, row: r, col: c }), col: c, x: (layout.prefix[c] ?? 0) - base, w: layout.widths[c] ?? 96 });
      out.push({ r, cells });
    }
    return out;
  }, [win, layout, sheet]);

  // ------------------------------------------------------------------ callouts (fracture focus)
  const callouts: Callout[] = useMemo(() => {
    const f = snap.focus;
    if (f === null || !snap.xray) return [];
    const expanded = expandWindow(win, ROWS, COLS);
    const inputs = new Map(f.artifact.failingInputs.map((i) => [U(i.cell), i]));
    const v = f.artifact.violatedAssertion;
    const violated = v.tier === 2 ? U(v.assertion.cell) : v.cell === null ? null : U(v.cell);
    const out: Callout[] = [];
    for (const k of f.lineage.cells) {
      const c = parseCellKey(k);
      if (c === null || c.sheet.toUpperCase() !== sheet.toUpperCase()) continue;
      if (c.row < expanded.top || c.row > expanded.bottom || c.col < expanded.left || c.col > expanded.right) continue;
      const rect = cellRect(c, win, layout);
      const inp = inputs.get(U(k));
      let text: string;
      let tone: Callout['tone'];
      if (U(k) === violated) {
        tone = 'violated';
        text = v.tier === 2 ? `✗ ${v.assertion.id}: ${formatSummary(v.observed)}` : `✗ ${v.invariant}`;
      } else if (inp !== undefined) {
        tone = 'input';
        text = `IN ${formatValue(decodeScalar(inp.value))}`;
      } else {
        tone = 'engine';
        const d = store.dialect(k);
        const chip = d === 'sql' || d === 'py' ? CHIP_LABEL[d] : 'FX';
        text = `${chip} → ${store.describe(f.callouts.get(k))}`;
      }
      // Right of the cell, past the 60 px bow of same-column threads, so pills never cover the fracture itself.
      out.push({ key: k, x: rect.x + rect.w + 70, y: rect.y + 3, text, tone });
    }
    return out;
  }, [snap.focus, snap.xray, sheet, win, layout, store]);

  // ------------------------------------------------------------------ input
  const focusGrid = (): void => scrollRef.current?.focus({ preventScroll: true });

  const onMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-editor]') !== null) return;
    const inspect = t.closest<HTMLElement>('[data-inspect]');
    const cell = t.closest<HTMLElement>('[data-key]');
    if (cell === null) return;
    const key = cell.dataset['key'] as CellKey;
    e.preventDefault();
    store.select(key);
    focusGrid();
    if (inspect !== null) store.openDrawer({ kind: 'cell', key: inspect.dataset['inspect'] as CellKey });
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>): void => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
    if (cell === null) return;
    const key = cell.dataset['key'] as CellKey;
    const d = store.dialect(key);
    store.beginEdit(key, null, d === 'sql' || d === 'py' ? 'bar' : 'cell');
  };

  const pageRows = Math.max(1, Math.floor((size.h - HEADER_HEIGHT) / ROW_HEIGHT) - 1);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (snap.draft !== null || e.target !== scrollRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const go = (fn: () => void): void => { e.preventDefault(); fn(); };
    switch (e.key) {
      case 'ArrowDown': return go(() => store.move('down'));
      case 'ArrowUp': return go(() => store.move('up'));
      case 'ArrowRight': return go(() => store.move('right'));
      case 'ArrowLeft': return go(() => store.move('left'));
      case 'Tab': return go(() => store.move(e.shiftKey ? 'left' : 'right'));
      case 'Enter': return go(() => store.move(e.shiftKey ? 'up' : 'down'));
      case 'PageDown': return go(() => store.move('down', pageRows));
      case 'PageUp': return go(() => store.move('up', pageRows));
      case 'Home': return go(() => (mod ? store.selectCoord(0, 0) : store.selectCoord(selRow, 0)));
      case 'End': if (mod) return go(() => store.selectCoord(ROWS - 1, selCol)); return;
      case 'Delete':
      case 'Backspace': return go(() => void store.clearCell(snap.selection));
      case 'F2': return go(() => store.beginEdit(snap.selection, null, 'cell'));
      default:
        if (e.key.length === 1 && !mod && !e.altKey) go(() => store.beginEdit(snap.selection, e.key, 'cell'));
    }
  };

  const editing = snap.draft !== null && snap.draft.where === 'cell' && parseCellKey(snap.draft.key)?.sheet.toUpperCase() === sheet.toUpperCase() ? snap.draft : null;
  const editCoord = editing === null ? null : parseCellKey(editing.key);
  const editRect = editCoord === null ? null : cellRect(editCoord, win, layout);

  const contentW = ROW_HEADER_WIDTH + totalWidth(layout);
  const contentH = HEADER_HEIGHT + bodyContentHeight(ROWS);
  const bodyW = Math.max(0, size.w - ROW_HEADER_WIDTH);
  const bodyH = Math.max(0, size.h - HEADER_HEIGHT);
  const rowW = (layout.prefix[win.right + 1] ?? 0) - (layout.prefix[win.left] ?? 0);
  const focusFracture = (): void => { store.setPanel('audit'); store.focusInXRay(); };

  return (
    <div className="relative min-h-0 flex-1 bg-slate-surface">
      <div
        ref={scrollRef} tabIndex={0} role="grid" aria-label={`Sheet ${sheet}`} aria-rowcount={ROWS} aria-colcount={COLS} aria-multiselectable={false}
        data-testid="grid" data-sheet={sheet} data-top={win.top} data-bottom={win.bottom}
        onKeyDown={onKeyDown} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}
        className="absolute inset-0 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-engine-formula/60"
      >
        <div style={{ width: contentW, height: contentH, position: 'relative' }}>
          <div className="overflow-hidden" style={{ position: 'sticky', top: 0, left: 0, width: size.w, height: size.h }}>
            {/* body */}
            <div className="absolute overflow-hidden" style={{ left: ROW_HEADER_WIDTH, top: HEADER_HEIGHT, width: bodyW, height: bodyH }}>
              <div ref={bodyRef} className={`absolute left-0 top-0 will-change-transform ${snap.xray ? 'xray-on' : ''}`}>
                {rows.map(({ r, cells }) => (
                  <div key={r} role="row" aria-rowindex={r + 1} className="absolute left-0" style={{ top: (r - win.top) * ROW_HEIGHT, height: ROW_HEIGHT, width: rowW }}>
                    {cells.map((c) => {
                      const src = store.source(c.key);
                      const d = src === null ? EMPTY_DISPLAY : cellDisplay(store.value(c.key), store.dialect(c.key));
                      const ku = U(c.key);
                      const dim = frame !== null && src !== null && !frame.involved.has(ku);
                      return (
                        <CellView key={c.key} cellKey={c.key} col={c.col} x={c.x} w={c.w} kind={d.kind} text={d.text} chip={d.chip} title={d.title} raw={d.raw}
                          selected={U(snap.selection) === ku} dim={dim} lineage={snap.xray && lineageSet.has(ku)} />
                      );
                    })}
                  </div>
                ))}
                {frame !== null && <XRayOverlay frame={frame} frameId={frameSeq.current} onOpenCounterexample={focusFracture} />}
                {callouts.map((c) => (
                  <div key={c.key} data-testid={`callout-${c.key}`} data-tone={c.tone}
                    className={`pointer-events-none absolute z-[4] whitespace-nowrap rounded-full border px-2 font-mono text-[10px] leading-[18px] shadow-lg ${c.tone === 'violated' ? 'border-fracture bg-fracture text-obsidian' : c.tone === 'input' ? 'border-fracture bg-slate-raised text-fracture' : 'border-fracture/60 bg-slate-raised text-ink'}`}
                    style={{ left: c.x, top: c.y }}>
                    {c.text}
                  </div>
                ))}
                {editing !== null && editRect !== null && (
                  <input
                    data-editor="cell" data-testid="cell-editor" autoFocus value={editing.text} spellCheck={false}
                    aria-label={`Edit ${editing.key}`}
                    onChange={(e) => store.updateDraft(e.target.value)}
                    onFocus={(e) => { const n = e.target.value.length; e.target.setSelectionRange(n, n); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void store.commitDraft(e.shiftKey ? 'up' : 'down'); focusGrid(); }
                      else if (e.key === 'Tab') { e.preventDefault(); void store.commitDraft(e.shiftKey ? 'left' : 'right'); focusGrid(); }
                      else if (e.key === 'Escape') { e.preventDefault(); store.cancelDraft(); focusGrid(); }
                    }}
                    className="absolute z-[5] h-6 border-2 border-engine-formula bg-obsidian px-1 font-mono text-[12px] text-ink outline-none"
                    style={{ left: editRect.x, top: editRect.y, width: Math.max(editRect.w, 220) }}
                  />
                )}
              </div>
            </div>
            {/* column header */}
            <div className="absolute overflow-hidden border-b border-slate-line bg-slate-raised" style={{ left: ROW_HEADER_WIDTH, top: 0, width: bodyW, height: HEADER_HEIGHT }}>
              <div ref={colHeadRef} className="absolute left-0 top-0 will-change-transform">
                {rows[0]?.cells.map((c) => (
                  <div key={c.col} aria-hidden="true" className={`absolute top-0 flex h-6 items-center justify-center border-r border-slate-line font-mono text-[10px] ${c.col === selCol ? 'bg-engine-formula/15 text-engine-formula' : 'text-ink-muted'}`} style={{ left: c.x, width: c.w }}>
                    {columnLetters(c.col)}
                  </div>
                ))}
              </div>
            </div>
            {/* row header */}
            <div className="absolute overflow-hidden border-r border-slate-line bg-slate-raised" style={{ left: 0, top: HEADER_HEIGHT, width: ROW_HEADER_WIDTH, height: bodyH }}>
              <div ref={rowHeadRef} className="absolute left-0 top-0 w-full will-change-transform">
                {rows.map(({ r }) => (
                  <div key={r} aria-hidden="true" data-testid={r === ROWS - 1 ? 'last-row-header' : undefined} className={`absolute left-0 flex h-6 w-full items-center justify-end border-b border-slate-line/70 pr-2 font-mono text-[10px] tabular ${r === selRow ? 'bg-engine-formula/15 text-engine-formula' : 'text-ink-muted'}`} style={{ top: (r - win.top) * ROW_HEIGHT }}>
                    {r + 1}
                  </div>
                ))}
              </div>
            </div>
            <div aria-hidden="true" className="absolute left-0 top-0 border-b border-r border-slate-line bg-slate-raised" style={{ width: ROW_HEADER_WIDTH, height: HEADER_HEIGHT }} />
          </div>
        </div>
      </div>
      {frame !== null && (frame.portals.length > 0 || frame.hidden > 0) && (
        <div className="pointer-events-none absolute right-4 z-10 flex max-w-[60%] flex-wrap justify-end gap-1.5" style={{ top: HEADER_HEIGHT + 6 }}>
          {frame.portals.map((p) => (
            <button key={`${p.direction}:${p.sheet}`} type="button" data-testid={`portal-${p.sheet}-${p.direction}`} data-fractured={p.fractured}
              onClick={() => { store.select(p.target); focusGrid(); }}
              title={p.direction === 'in' ? `${p.count} precedent link(s) from sheet ${p.sheet}: jump there` : `${p.count} dependent link(s) on sheet ${p.sheet}: jump there`}
              className={`pointer-events-auto flex items-center gap-1 rounded-full border bg-slate-raised/95 px-2 py-0.5 font-mono text-[10px] shadow-lg hover:bg-slate-raised ${p.fractured ? 'suture-pulse border-fracture text-fracture' : `${ENGINE_BORDER[p.engine]} ${ENGINE_TEXT[p.engine]}`}`}>
              {p.direction === 'in' ? `◂ ${p.sheet}` : `${p.sheet} ▸`}<span className="tabular text-ink-muted">·{p.count}</span>
            </button>
          ))}
          {frame.hidden > 0 && <span data-testid="xray-hidden" className="rounded-full border border-slate-line bg-slate-raised px-2 py-0.5 font-mono text-[10px] text-ink-muted">{frame.hidden.toLocaleString('en-US')} threads hidden</span>}
        </div>
      )}
    </div>
  );
}
