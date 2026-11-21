import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXORCIST, runArbitrary, uniformFloat, uniformStep, type SutureDocument } from '../index.ts';
import { key, workbook } from './helpers.ts';

/**
 * Spec 03 §4.1: float fuzz domains are uniform over VALUES. The previous `fc.double({ min, max })` was uniform over IEEE-754
 * bit patterns, which on [0, 0.35] put almost every draw next to 0 (audit log: Flagship 2 hit ~20× below its share).
 */
const SEED = 20261121;
const N = 20_000;

/** Share of samples in each quarter of [min, max]. */
function quartiles(xs: ReadonlyArray<number>, min: number, max: number): number[] {
  const q = [0, 0, 0, 0];
  for (const x of xs) q[Math.min(3, Math.floor(((x - min) / (max - min)) * 4))]! += 1;
  return q.map((c) => c / xs.length);
}

/** Finite bounds min < max, including huge, tiny, negative, and zero-straddling domains. */
const finiteDomain = fc
  .tuple(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ noNaN: true, noDefaultInfinity: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): readonly [number, number] => (a < b ? [a, b] : [b, a]));

describe('uniformFloat (Spec 03 §4.1)', () => {
  it('every draw lies inside [min, max] for any finite domain, including the full double range', () => {
    fc.assert(
      fc.property(finiteDomain, fc.integer(), ([min, max], seed) => {
        for (const x of fc.sample(uniformFloat(min, max), { seed, numRuns: 50 })) {
          if (!(x >= min && x <= max)) return false;
        }
        return true;
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('reaches exactly min and exactly max (fast-check biases the underlying integer toward its bounds)', () => {
    const xs = fc.sample(uniformFloat(0, 0.35), { seed: SEED, numRuns: N });
    expect(xs).toContain(0);
    expect(xs).toContain(0.35);
    const ys = fc.sample(uniformFloat(0.95, 1.1), { seed: SEED, numRuns: N });
    expect(ys).toContain(0.95);
    expect(ys).toContain(1.1);
  });

  it('is uniform over values: each quarter of [0, 0.35] holds 25 % ± 1.5 % of unbiased draws', () => {
    const q = quartiles(fc.sample(fc.noBias(uniformFloat(0, 0.35)), { seed: SEED, numRuns: N }), 0, 0.35);
    for (const share of q) expect(Math.abs(share - 0.25)).toBeLessThan(0.015);
  });

  it('covers the upper half of [0, 0.35]; fc.double (the old sampler) starves it', () => {
    const upper = (xs: ReadonlyArray<number>): number => xs.filter((x) => x >= 0.175).length / xs.length;
    const oldArb = fc.double({ min: 0, max: 0.35, noNaN: true, noDefaultInfinity: true });
    const now = upper(fc.sample(uniformFloat(0, 0.35), { seed: SEED, numRuns: N }));
    const before = upper(fc.sample(oldArb, { seed: SEED, numRuns: N }));
    const beforeUnbiased = upper(fc.sample(fc.noBias(oldArb), { seed: SEED, numRuns: N }));
    console.info(`[sampler] share of draws in [0.175, 0.35] (as fast-check generates them): uniformFloat ${(now * 100).toFixed(1)} %, fc.double ${(before * 100).toFixed(2)} % (${(beforeUnbiased * 100).toFixed(2)} % without bias)`);
    expect(now).toBeGreaterThan(0.4);
    // The old sampler reached the upper half only through fast-check's bias toward the domain bounds.
    expect(before).toBeLessThan(0.1);
    expect(beforeUnbiased).toBeLessThan(0.01);
  });

  it('shrinks toward min: a failure above a threshold shrinks to just above the threshold, never below min', () => {
    for (const [min, max, threshold] of [[0, 0.35, 0.2], [0.95, 1.1, 1.0], [-50, 50, -10]] as const) {
      const out = fc.check(fc.property(uniformFloat(min, max), (x) => x < threshold), { seed: SEED, numRuns: 1000 });
      expect(out.failed).toBe(true);
      const cx = out.counterexample?.[0];
      expect(typeof cx).toBe('number');
      if (typeof cx !== 'number') continue;
      expect(cx).toBeGreaterThanOrEqual(threshold);
      expect(cx - threshold).toBeLessThan((max - min) * 1e-6);
      expect(out.numShrinks).toBeGreaterThan(0);
    }
  });
});

describe('uniformStep: the monotonicWith step uses the same mapping', () => {
  it('draws lie in (0, span], reach span exactly, and are uniform over values', () => {
    const xs = fc.sample(uniformStep(0.35), { seed: SEED, numRuns: N });
    expect(xs.every((x) => x > 0 && x <= 0.35)).toBe(true);
    expect(xs).toContain(0.35);
    const q = quartiles(fc.sample(fc.noBias(uniformStep(0.35)), { seed: SEED, numRuns: N }), 0, 0.35);
    for (const share of q) expect(Math.abs(share - 0.25)).toBeLessThan(0.015);
  });

  it('runArbitrary draws one positive step per monotonicWith assertion, uniform over (0, span]', () => {
    const doc: SutureDocument = {
      format: 'suture.workbook', version: 1, title: 'step', workbook: workbook({ A1: '0.1', B1: '=A1*2' }),
      exorcist: {
        ...DEFAULT_EXORCIST,
        inputs: [{ cell: key('Sheet1', 'A1'), domain: { kind: 'float', min: 0, max: 0.35 } }],
        assertions: [{ id: 'up', cell: key('Sheet1', 'B1'), kind: 'monotonicWith', input: key('Sheet1', 'A1'), direction: 'nonDecreasing' }],
      },
    };
    const samples = fc.sample(fc.noBias(runArbitrary(doc)), { seed: SEED, numRuns: N });
    const steps = samples.map((s) => s.steps[0]);
    expect(samples.every((s) => s.steps.length === 1)).toBe(true);
    const numeric = steps.filter((x): x is number => typeof x === 'number');
    expect(numeric.length).toBe(N);
    expect(numeric.every((x) => x > 0 && x <= 0.35)).toBe(true);
    for (const share of quartiles(numeric, 0, 0.35)) expect(Math.abs(share - 0.25)).toBeLessThan(0.015);
  });
});
