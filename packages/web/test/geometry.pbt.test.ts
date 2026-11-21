import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arcLength, brokenThread, MAX_OFFSET, MIN_OFFSET, pointAt, splitAt, threadCurve, toPathD, type Bezier, type Rect } from '../src/xray/geometry.ts';

/** Spec 04 task 5.1 — X-Ray geometry properties. */
const coord = fc.double({ min: -2000, max: 4000, noNaN: true, noDefaultInfinity: true });
const point = fc.record({ x: coord, y: coord });
const bezier: fc.Arbitrary<Bezier> = fc.record({ p0: point, p1: point, p2: point, p3: point });
const rect: fc.Arbitrary<Rect> = fc.record({ x: fc.integer({ min: 0, max: 3000 }), y: fc.integer({ min: 0, max: 3000 }), w: fc.integer({ min: 40, max: 340 }), h: fc.constant(24) });

describe('xray/geometry', () => {
  it('splitAt halves reproduce the original curve points within 1e-9 px', () => {
    fc.assert(fc.property(bezier, fc.double({ min: 0.05, max: 0.95, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (b, t, u) => {
      const [a, c] = splitAt(b, t);
      const original = pointAt(b, u);
      const half = u <= t ? pointAt(a, u / t) : pointAt(c, (u - t) / (1 - t));
      expect(Math.abs(original.x - half.x)).toBeLessThan(1e-9 * Math.max(1, Math.abs(original.x)) + 1e-9);
      expect(Math.abs(original.y - half.y)).toBeLessThan(1e-9 * Math.max(1, Math.abs(original.y)) + 1e-9);
    }), { seed: 7, numRuns: 400 });
  });

  it('control offsets are clamped to [40, 240] (or 60 in the same column)', () => {
    fc.assert(fc.property(rect, rect, (from, to) => {
      const b = threadCurve(from, to);
      const o1 = Math.abs(b.p1.x - b.p0.x);
      const o2 = Math.abs(b.p3.x - b.p2.x);
      const sameColumn = from.x === to.x && from.w === to.w;
      if (sameColumn) {
        expect(o1).toBe(60);
        expect(o2).toBe(60);
      } else {
        expect(o1).toBeGreaterThanOrEqual(MIN_OFFSET);
        expect(o1).toBeLessThanOrEqual(MAX_OFFSET);
        expect(o2).toBeCloseTo(o1, 9);
      }
      expect(b.p1.y).toBe(b.p0.y);
      expect(b.p2.y).toBe(b.p3.y);
    }), { seed: 11, numRuns: 400 });
  });

  it('the broken thread leaves a 6 ± 0.1 px gap of arc length around t = 0.5', () => {
    fc.assert(fc.property(rect, rect, (from, to) => {
      const b = threadCurve(from, to);
      fc.pre(arcLength(b) > 40);
      const br = brokenThread(b, 6);
      const gap = Math.hypot(br.gapEnd.x - br.gapStart.x, br.gapEnd.y - br.gapStart.y);
      // The chord of a 6 px arc is at most 6 px; on these gentle curves it is within 0.1 px of it.
      expect(gap).toBeLessThanOrEqual(6 + 0.1);
      expect(gap).toBeGreaterThanOrEqual(6 - 0.1);
      expect(br.halves[0].startsWith('M ')).toBe(true);
      expect(br.ticks).toHaveLength(2);
    }), { seed: 13, numRuns: 200 });
  });

  it('toPathD writes one cubic segment', () => {
    expect(toPathD({ p0: { x: 0, y: 0 }, p1: { x: 40, y: 0 }, p2: { x: 60, y: 24 }, p3: { x: 100, y: 24 } })).toBe('M 0 0 C 40 0, 60 24, 100 24');
  });
});
