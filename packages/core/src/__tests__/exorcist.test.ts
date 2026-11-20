import { describe, expect, it } from 'vitest';
import {
  createExorcistSession, fromReplayFragment, NEVER_CANCELLED, toReplayFragment, DEFAULT_EXORCIST,
  type ExorcistSession, type SutureDocument,
} from '../index.ts';
import { formulaOnlyDeps, key, storedDeflate, testHasher, workbook } from './helpers.ts';

/** Pure-formula runway model: D1 divides cash by net burn with no guard (the realistic flaw). */
function runwayDoc(): SutureDocument {
  return {
    format: 'suture.workbook', version: 1, title: 'runway (formula-only)',
    workbook: workbook({
      A1: '180000', // monthly cost
      A2: '120000', // monthly revenue
      C1: '2400000', // starting cash
      C2: '1', // churn shock multiplier
      B1: '=A1-A2*(1.6-0.6*C2)', // projected net burn: lower churn shock → more retained revenue
      D1: '=C1/B1', // runway (months), unguarded
    }),
    exorcist: {
      ...DEFAULT_EXORCIST,
      inputs: [
        { cell: key('Sheet1', 'C1'), domain: { kind: 'float', min: 100_000, max: 5_000_000 } },
        { cell: key('Sheet1', 'C2'), domain: { kind: 'float', min: 0, max: 3 } },
      ],
      assertions: [
        { id: 'runway-non-negative', cell: key('Sheet1', 'D1'), kind: 'gte', operand: { kind: 'const', value: 0 } },
        { id: 'runway-defined', cell: key('Sheet1', 'D1'), kind: 'notError' },
      ],
    },
  };
}

const deps = { engine: formulaOnlyDeps, hasher: testHasher, compressor: storedDeflate, versions: { suture: '0.1.0', fastCheck: '4.10.3' } };

async function session(doc: SutureDocument): Promise<ExorcistSession> {
  const s = await createExorcistSession(doc, deps);
  if ('configError' in s) throw new Error(s.configError);
  return s;
}

describe('Exorcist (in-process mode)', () => {
  it('finds, shrinks, and exactly replays the unguarded runway cliff', async () => {
    const doc = runwayDoc();
    const s = await session(doc);
    expect(s.mode).toBe('inProcess');
    const t0 = performance.now();
    const verdict = await s.run({ seed: 1234, token: NEVER_CANCELLED, onProgress: () => undefined });
    const ms = performance.now() - t0;
    expect(verdict.kind).toBe('violated');
    if (verdict.kind !== 'violated') return;
    const a = verdict.artifact;
    expect(a.violatedAssertion.tier).toBe(2);
    if (a.violatedAssertion.tier === 2) expect(a.violatedAssertion.assertion.id).toBe('runway-non-negative');
    expect(a.lineagePath.cells).toContain(key('Sheet1', 'B1'));
    expect(a.lineagePath.cells[a.lineagePath.cells.length - 1]).toBe(key('Sheet1', 'D1'));
    expect(ms).toBeLessThan(2000); // Spec 03 Req 4.3 budget (search + shrink)

    const again = await (await session(doc)).run({ seed: 1234, token: NEVER_CANCELLED, onProgress: () => undefined });
    expect(again.kind === 'violated' && { ...again.artifact, createdAt: '' }).toEqual({ ...a, createdAt: '' });

    const replay = await (await session(doc)).replay(a, NEVER_CANCELLED);
    expect(replay).toMatchObject({ kind: 'reproduced', exact: true });

    const fragment = await toReplayFragment(a, storedDeflate);
    expect(typeof fragment).toBe('string');
    if (typeof fragment === 'string') expect(await fromReplayFragment(`#${fragment}`, storedDeflate)).toEqual(a);
  });

  it('passes 1,000 runs on a guarded model in under 2 s', async () => {
    const doc = runwayDoc();
    const cells = doc.workbook.sheets[0]?.cells.map((c) => (c.key === key('Sheet1', 'D1') ? { key: c.key, raw: '=IF(B1<=0, 120, C1/B1)' } : c)) ?? [];
    const guarded: SutureDocument = { ...doc, workbook: { ...doc.workbook, sheets: [{ name: 'Sheet1', cells }] } };
    const t0 = performance.now();
    const verdict = await (await session(guarded)).run({ seed: 99, token: NEVER_CANCELLED, onProgress: () => undefined });
    const ms = performance.now() - t0;
    expect(verdict).toMatchObject({ kind: 'passed', runs: 1000 });
    expect(ms).toBeLessThan(2000); // Spec 03 Req 4.2 budget
  });

  it('rejects a modified workbook on replay (hash mismatch)', async () => {
    const doc = runwayDoc();
    const v = await (await session(doc)).run({ seed: 5, token: NEVER_CANCELLED, onProgress: () => undefined });
    if (v.kind !== 'violated') throw new Error('expected a violation');
    const changed: SutureDocument = { ...doc, title: doc.title, exorcist: { ...doc.exorcist, numRuns: 999 } };
    expect(await (await session(changed)).replay(v.artifact, NEVER_CANCELLED)).toMatchObject({ kind: 'hashMismatch' });
  });

  it('rejects invalid configurations', async () => {
    const doc = runwayDoc();
    const bad: SutureDocument = { ...doc, exorcist: { ...doc.exorcist, inputs: [{ cell: key('Sheet1', 'D1'), domain: { kind: 'float', min: 0, max: 1 } }] } };
    expect(await createExorcistSession(bad, deps)).toMatchObject({ configError: expect.stringMatching(/not a literal/) });
  });
});
