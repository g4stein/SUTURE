import { parseCellKey, type CellCoord, type CellKey, type EngineId, type LineageEdge, type LineagePath } from '@suture/core';
import { cellRect, type ColumnLayout, type VisibleWindow } from '../grid/viewport.ts';
import { brokenThread, stubPath, threadCurve, toPathD, type Point } from './geometry.ts';

export const MAX_THREADS = 1500;
export const MAX_FLOW = 64;

export interface XRayThread {
  readonly id: string;
  readonly edge: LineageEdge;
  /** Engine of edge.to (the dependent): steering §2. */
  readonly engine: EngineId;
  readonly d: string;
  readonly broken: { readonly halves: readonly [string, string]; readonly ticks: readonly [string, string] } | null;
  readonly fractured: boolean;
  readonly touchesSelection: boolean;
  /** Animated flow highlight (selection-adjacent, capped at MAX_FLOW). */
  readonly flow: boolean;
}

export interface XRayStub {
  readonly id: string;
  readonly d: string;
  readonly anchor: Point;
  readonly engine: EngineId;
  readonly fractured: boolean;
  readonly direction: 'in' | 'out';
  readonly sheet: string;
}

export interface XRayPortal {
  readonly sheet: string;
  /** in: precedents on `sheet` feed this sheet; out: dependents on `sheet` read this sheet. */
  readonly direction: 'in' | 'out';
  readonly count: number;
  readonly engine: EngineId;
  /** Cell on `sheet` to jump to. */
  readonly target: CellKey;
  readonly fractured: boolean;
}

export interface XRayFrame {
  readonly threads: ReadonlyArray<XRayThread>;
  readonly stubs: ReadonlyArray<XRayStub>;
  readonly portals: ReadonlyArray<XRayPortal>;
  /** Threads beyond the cap that were not drawn (Req 5.4). */
  readonly hidden: number;
  /** Upper-cased keys of cells that stay bright; every other cell dims (fracture > selection > all connected). */
  readonly involved: ReadonlySet<string>;
}

export interface XRayInput {
  readonly sheet: string;
  readonly cells: ReadonlyArray<CellKey>;
  readonly precedents: (k: CellKey) => ReadonlyArray<CellKey>;
  readonly dependents: (k: CellKey) => ReadonlyArray<CellKey>;
  readonly engineOf: (k: CellKey) => EngineId;
  readonly window: VisibleWindow;
  readonly expanded: VisibleWindow;
  readonly layout: ColumnLayout;
  readonly selection: CellKey | null;
  readonly lineage: LineagePath | null;
  readonly maxThreads?: number;
  readonly maxFlow?: number;
}

const U = (k: string): string => k.toUpperCase();
const edgeId = (e: LineageEdge): string => `${U(e.from)}→${U(e.to)}`;

function inWindow(c: CellCoord, w: VisibleWindow): boolean {
  return c.row >= w.top && c.row <= w.bottom && c.col >= w.left && c.col <= w.right;
}

/** Spec 04 §5.2 — which threads to draw for the current window, and how. Pure: all graph access goes through `input`. */
export function computeXRayFrame(input: XRayInput): XRayFrame {
  const maxThreads = input.maxThreads ?? MAX_THREADS;
  const maxFlow = input.maxFlow ?? MAX_FLOW;
  const sheetU = input.sheet.toUpperCase();
  const coords = new Map<string, CellCoord | null>();
  const coordOf = (k: CellKey): CellCoord | null => {
    const u = U(k);
    let c = coords.get(u);
    if (c === undefined) {
      c = parseCellKey(k);
      coords.set(u, c);
    }
    return c;
  };
  const onSheet = (k: CellKey): boolean => coordOf(k)?.sheet.toUpperCase() === sheetU;

  const lineageIds = new Set((input.lineage?.edges ?? []).map(edgeId));
  const failingEdge = input.lineage?.failingEdge ?? null;
  const failingId = failingEdge === null ? null : edgeId(failingEdge);
  const selU = input.selection === null ? null : U(input.selection);

  const edges = new Map<string, LineageEdge>();
  for (const k of input.cells) {
    const c = coordOf(k);
    if (c === null || !inWindow(c, input.expanded)) continue;
    for (const p of input.precedents(k)) edges.set(edgeId({ from: p, to: k }), { from: p, to: k });
    for (const d of input.dependents(k)) edges.set(edgeId({ from: k, to: d }), { from: k, to: d });
  }
  // Lineage edges inside the expanded window are always drawn, even if the graph walk above missed them.
  for (const e of input.lineage?.edges ?? []) {
    const a = coordOf(e.from);
    const b = coordOf(e.to);
    if ((a !== null && onSheet(e.from) && inWindow(a, input.expanded)) || (b !== null && onSheet(e.to) && inWindow(b, input.expanded))) edges.set(edgeId(e), e);
  }

  const local: LineageEdge[] = [];
  const cross: LineageEdge[] = [];
  for (const e of edges.values()) {
    const fromOn = onSheet(e.from);
    const toOn = onSheet(e.to);
    if (fromOn && toOn) local.push(e);
    else if (fromOn || toOn) cross.push(e);
  }

  const touches = (e: LineageEdge): boolean => selU !== null && (U(e.from) === selU || U(e.to) === selU);
  let drawn = local;
  let hidden = 0;
  if (local.length > maxThreads) {
    drawn = local.filter((e) => touches(e) || lineageIds.has(edgeId(e)));
    hidden = local.length - drawn.length;
  }

  let flows = 0;
  const threads: XRayThread[] = [];
  for (const e of drawn) {
    const a = coordOf(e.from);
    const b = coordOf(e.to);
    if (a === null || b === null) continue;
    const curve = threadCurve(cellRect(a, input.window, input.layout), cellRect(b, input.window, input.layout));
    const id = edgeId(e);
    const fractured = lineageIds.has(id);
    const isBroken = fractured && failingId === id;
    const t = touches(e);
    const flow = t && !fractured && flows < maxFlow;
    if (flow) flows++;
    const br = isBroken ? brokenThread(curve) : null;
    threads.push({ id, edge: e, engine: input.engineOf(e.to), d: toPathD(curve), broken: br === null ? null : { halves: br.halves, ticks: br.ticks }, fractured, touchesSelection: t, flow });
  }

  const stubs: XRayStub[] = [];
  const portals = new Map<string, { sheet: string; direction: 'in' | 'out'; count: number; engine: EngineId; target: CellKey; fractured: boolean }>();
  const stubbed = new Set<string>();
  for (const e of cross) {
    const incoming = onSheet(e.to);
    const localKey = incoming ? e.to : e.from;
    const remoteKey = incoming ? e.from : e.to;
    const lc = coordOf(localKey);
    const rc = coordOf(remoteKey);
    if (lc === null || rc === null) continue;
    const fractured = lineageIds.has(edgeId(e));
    const engine = input.engineOf(e.to);
    const sid = `${incoming ? 'in' : 'out'}:${U(localKey)}:${rc.sheet.toUpperCase()}`;
    if (!stubbed.has(sid) && inWindow(lc, input.expanded)) {
      stubbed.add(sid);
      const s = stubPath(cellRect(lc, input.window, input.layout), incoming ? 'in' : 'out');
      stubs.push({ id: sid, d: s.d, anchor: s.anchor, engine, fractured, direction: incoming ? 'in' : 'out', sheet: rc.sheet });
    } else if (fractured) {
      const existing = stubs.find((s) => s.id === sid);
      if (existing !== undefined && !existing.fractured) stubs[stubs.indexOf(existing)] = { ...existing, fractured: true };
    }
    const pid = `${incoming ? 'in' : 'out'}:${rc.sheet.toUpperCase()}`;
    const prev = portals.get(pid);
    if (prev === undefined) portals.set(pid, { sheet: rc.sheet, direction: incoming ? 'in' : 'out', count: 1, engine, target: remoteKey, fractured });
    else {
      prev.count++;
      if (fractured && !prev.fractured) {
        prev.fractured = true;
        prev.target = remoteKey;
      }
    }
  }

  const involved = new Set<string>();
  if (input.lineage !== null && input.lineage.cells.length > 0) {
    for (const c of input.lineage.cells) involved.add(U(c));
  } else {
    const selEdges = [...edges.values()].filter(touches);
    if (selU !== null && selEdges.length > 0) {
      involved.add(selU);
      for (const e of selEdges) { involved.add(U(e.from)); involved.add(U(e.to)); }
    } else {
      for (const e of edges.values()) { involved.add(U(e.from)); involved.add(U(e.to)); }
    }
  }

  const order = (p: XRayPortal): number => (p.direction === 'in' ? 0 : 1);
  return {
    threads,
    stubs,
    portals: [...portals.values()].sort((a, b) => order(a) - order(b) || a.sheet.localeCompare(b.sheet)),
    hidden,
    involved,
  };
}
