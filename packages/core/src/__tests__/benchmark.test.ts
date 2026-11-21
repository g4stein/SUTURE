import { describe, expect, it } from 'vitest';
import { createExorcistSession, DEFAULT_EXORCIST, NEVER_CANCELLED, type SutureDocument } from '../index.ts';
import { a1 } from './arbitraries.ts';
import { formulaOnlyDeps, key, storedDeflate, testHasher, workbook } from './helpers.ts';

/**
 * Spec 03 §10 reference workbooks: 5 float fuzz inputs (A1:A5) feed 50 formula cells in 10 layers of 5 (columns B..K).
 * Every layer reads only the previous layer through monotone kernels, so dependency depth is exactly 10.
 */
function reference(failing: boolean): SutureDocument {
  const cells: Record<string, string> = {};
  for (let i = 0; i < 5; i++) cells[a1(i, 0)] = String(i + 1);
  const kernels = [
    (p: string[]) => `=SUM(${p[0]}, ${p[1]})*0.5`,
    (p: string[]) => `=MAX(${p[1]}, ${p[2]})+ABS(${p[3]})*0.1`,
    (p: string[]) => `=AVERAGE(${p[0]}, ${p[2]}, ${p[4]})`,
    (p: string[]) => `=ROUND(${p[3]}*0.9+${p[4]}*0.1, 6)`,
    (p: string[]) => `=IF(${p[0]}>=0, ${p[0]}*0.25+${p[1]}*0.75, 0)`,
  ];
  for (let layer = 1; layer <= 10; layer++) {
    const prev = [0, 1, 2, 3, 4].map((r) => a1(r, layer - 1));
    for (let r = 0; r < 5; r++) cells[a1(r, layer)] = (kernels[r] ?? kernels[0])?.(prev) ?? '';
  }
  const last = key('Sheet1', a1(0, 10));
  return {
    format: 'suture.workbook', version: 1, title: failing ? 'reference-fail' : 'reference-pass', workbook: workbook(cells),
    exorcist: {
      ...DEFAULT_EXORCIST,
      inputs: [0, 1, 2, 3, 4].map((i) => ({ cell: key('Sheet1', a1(i, 0)), domain: { kind: 'float' as const, min: 0, max: 100 } })),
      assertions: [
        { id: 'non-negative', cell: last, kind: 'gte', operand: { kind: 'const', value: 0 } },
        { id: 'defined', cell: last, kind: 'notError' },
        { id: 'monotone-in-A1', cell: last, kind: 'monotonicWith', input: key('Sheet1', 'A1'), direction: 'nonDecreasing' },
        // ~5% failing region: the output exceeds 92 only near the top corner of the domain.
        ...(failing ? [{ id: 'below-92', cell: last, kind: 'lt' as const, operand: { kind: 'const' as const, value: 92 } }] : []),
      ],
    },
  };
}

const deps = { engine: formulaOnlyDeps, hasher: testHasher, compressor: storedDeflate, versions: { suture: '0.2.0', fastCheck: '4.10.3' } };

async function timed(doc: SutureDocument, seed: number): Promise<{ ms: number; kind: string; runs: number }> {
  const s = await createExorcistSession(doc, deps);
  if ('configError' in s) throw new Error(s.configError);
  const t0 = performance.now();
  const v = await s.run({ seed, token: NEVER_CANCELLED, onProgress: () => undefined });
  return { ms: performance.now() - t0, kind: v.kind, runs: v.kind === 'passed' ? v.runs : 0 };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Infinity;

describe('Spec 03 §10 acceptance benchmark (Node, in-process mode)', () => {
  it('reference-pass: 1,000 runs over 50 cells, depth 10 — median of 5 under 2,000 ms', async () => {
    const doc = reference(false);
    expect(doc.workbook.sheets[0]?.cells.length).toBe(55);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await timed(doc, 1000 + i);
      expect(r).toMatchObject({ kind: 'passed', runs: 1000 });
      runs.push(r.ms);
    }
    console.info(`[bench] reference-pass 1,000 runs: median ${median(runs).toFixed(0)} ms (runs: ${runs.map((x) => x.toFixed(0)).join(', ')} ms)`);
    expect(median(runs)).toBeLessThan(2000);
  });

  it('reference-fail: search + shrink + simplify — median of 5 under 2,000 ms', async () => {
    const doc = reference(true);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await timed(doc, 2000 + i);
      expect(r.kind).toBe('violated');
      runs.push(r.ms);
    }
    console.info(`[bench] reference-fail discovery: median ${median(runs).toFixed(0)} ms (runs: ${runs.map((x) => x.toFixed(0)).join(', ')} ms)`);
    expect(median(runs)).toBeLessThan(2000);
  });
});
