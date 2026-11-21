/** Spec 04 §5.1 — X-Ray thread geometry (pure). */
export interface Point { readonly x: number; readonly y: number }
export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface Bezier { readonly p0: Point; readonly p1: Point; readonly p2: Point; readonly p3: Point }

export const MIN_OFFSET = 40;
export const MAX_OFFSET = 240;
export const SAME_COLUMN_OFFSET = 60;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Precedent → dependent curve. `to` right of `from`: right-middle → left-middle; left of it: left-middle → right-middle;
 * the same column: right-middle → right-middle, bowing outward. Control points are offset horizontally by
 * clamp(|Δx| / 2, 40, 240), or 60 in the same column.
 */
export function threadCurve(from: Rect, to: Rect): Bezier {
  const fromMidY = from.y + from.h / 2;
  const toMidY = to.y + to.h / 2;
  const sameColumn = Math.abs(from.x - to.x) < 0.5 && Math.abs(from.w - to.w) < 0.5;
  if (sameColumn) {
    const p0 = { x: from.x + from.w, y: fromMidY };
    const p3 = { x: to.x + to.w, y: toMidY };
    return { p0, p1: { x: p0.x + SAME_COLUMN_OFFSET, y: p0.y }, p2: { x: p3.x + SAME_COLUMN_OFFSET, y: p3.y }, p3 };
  }
  const rightward = to.x >= from.x + from.w || to.x > from.x;
  const p0 = rightward ? { x: from.x + from.w, y: fromMidY } : { x: from.x, y: fromMidY };
  const p3 = rightward ? { x: to.x, y: toMidY } : { x: to.x + to.w, y: toMidY };
  const o = clamp(Math.abs(p3.x - p0.x) / 2, MIN_OFFSET, MAX_OFFSET);
  const dir = rightward ? 1 : -1;
  return { p0, p1: { x: p0.x + dir * o, y: p0.y }, p2: { x: p3.x - dir * o, y: p3.y }, p3 };
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

export function toPathD(b: Bezier): string {
  return `M ${f(b.p0.x)} ${f(b.p0.y)} C ${f(b.p1.x)} ${f(b.p1.y)}, ${f(b.p2.x)} ${f(b.p2.y)}, ${f(b.p3.x)} ${f(b.p3.y)}`;
}

export function pointAt(b: Bezier, t: number): Point {
  const a = lerp(b.p0, b.p1, t);
  const m = lerp(b.p1, b.p2, t);
  const c = lerp(b.p2, b.p3, t);
  return lerp(lerp(a, m, t), lerp(m, c, t), t);
}

/** de Casteljau split at t: two cubic beziers that together trace the original curve exactly. */
export function splitAt(b: Bezier, t: number): readonly [Bezier, Bezier] {
  const p01 = lerp(b.p0, b.p1, t);
  const p12 = lerp(b.p1, b.p2, t);
  const p23 = lerp(b.p2, b.p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const mid = lerp(p012, p123, t);
  return [{ p0: b.p0, p1: p01, p2: p012, p3: mid }, { p0: mid, p1: p123, p2: p23, p3: b.p3 }];
}

/** Arc length between t0 and t1 by polyline approximation (64 segments per unit t). */
export function arcLength(b: Bezier, t0 = 0, t1 = 1): number {
  const n = Math.max(8, Math.ceil(Math.abs(t1 - t0) * 256));
  let len = 0;
  let prev = pointAt(b, t0);
  for (let i = 1; i <= n; i++) {
    const p = pointAt(b, t0 + ((t1 - t0) * i) / n);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/** The t at which the arc length measured from `t0` (towards t = 1 if dir > 0, else towards 0) reaches `dist`. */
function tAtDistance(b: Bezier, t0: number, dist: number, dir: 1 | -1): number {
  let lo = 0;
  let hi = dir > 0 ? 1 - t0 : t0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const t = t0 + dir * mid;
    const d = dir > 0 ? arcLength(b, t0, t) : arcLength(b, t, t0);
    if (d < dist) lo = mid;
    else hi = mid;
  }
  return t0 + dir * ((lo + hi) / 2);
}

export interface BrokenThread {
  readonly halves: readonly [string, string];
  /** Two short ticks perpendicular to the curve at the fracture. */
  readonly ticks: readonly [string, string];
  /** Tangent-space data for tests: the trimmed endpoints at the gap. */
  readonly gapStart: Point;
  readonly gapEnd: Point;
}

/** Broken thread with a gap of `gapPx` arc length centred at t = 0.5 (Spec 04 §5.1). */
export function brokenThread(b: Bezier, gapPx = 6, tickPx = 6): BrokenThread {
  const ta = tAtDistance(b, 0.5, gapPx / 2, -1);
  const tb = tAtDistance(b, 0.5, gapPx / 2, 1);
  const [firstAll] = splitAt(b, ta);
  const [, secondAll] = splitAt(b, tb);
  const tick = (t: number): string => {
    const p = pointAt(b, t);
    const q = pointAt(b, Math.min(1, t + 1e-3));
    const r = pointAt(b, Math.max(0, t - 1e-3));
    const dx = q.x - r.x;
    const dy = q.y - r.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (tickPx / 2);
    const ny = (dx / len) * (tickPx / 2);
    return `M ${f(p.x - nx)} ${f(p.y - ny)} L ${f(p.x + nx)} ${f(p.y + ny)}`;
  };
  return { halves: [toPathD(firstAll), toPathD(secondAll)], ticks: [tick(ta), tick(tb)], gapStart: pointAt(b, ta), gapEnd: pointAt(b, tb) };
}

/**
 * Short horizontal stub for a cross-sheet edge: entering a cell's left edge (precedent on another sheet) or leaving
 * its right edge (dependent on another sheet). The anchor dot sits at the outer end; the sheet-portal badge names it.
 */
export function stubPath(cell: Rect, side: 'in' | 'out', lengthPx = 12): { readonly d: string; readonly anchor: Point } {
  const y = cell.y + cell.h / 2;
  const x0 = side === 'in' ? cell.x - lengthPx : cell.x + cell.w;
  const x1 = side === 'in' ? cell.x : cell.x + cell.w + lengthPx;
  return { d: `M ${f(x0)} ${f(y)} L ${f(x1)} ${f(y)}`, anchor: { x: side === 'in' ? x0 : x1, y } };
}
