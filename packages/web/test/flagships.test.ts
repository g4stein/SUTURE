import { deflateRawSync, inflateRawSync } from 'node:zlib';
import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createExorcistSession, createWorkbookEngine, decodeScalar, fromReplayFragment, NEVER_CANCELLED, toReplayFragment,
  type CellKey, type CellValue, type Compressor, type ExorcistDeps, type ExorcistSession, type FuzzDomain, type SutureDocument,
} from '@suture/core';
import { nodeEngines, nodeSha256, type NodeEngines } from './hosts/nodeEngines.ts';
import { SAAS_NOTES, saasRunwayDocument } from '../src/workbooks/saasRunway.ts';
import { ECOMMERCE_NOTES, ecommerceMarginDocument } from '../src/workbooks/ecommerceMargin.ts';
import type { WorkbookNotes } from '../src/workbooks/build.ts';

/**
 * Spec 04 Req 10 — genuine discovery against the REAL engines (DuckDB-WASM + Pyodide/NumPy, same handlers as the browser
 * workers). The tests contain no input values, counterexamples, or fixed seeds for discovery: they assert only assertion
 * ids, verdict kinds, and replay outcomes. The estimation and control tests use fixed sampling seeds (Spec 04 §8).
 */
const zlib: Compressor = {
  deflateRaw: (b) => Promise.resolve(new Uint8Array(deflateRawSync(b))),
  inflateRaw: (b) => Promise.resolve(new Uint8Array(inflateRawSync(b))),
};

let engines: NodeEngines;
beforeAll(async () => {
  engines = await nodeEngines();
  console.info(`[flagship] real engines: DuckDB ${engines.versions.duckdb} (validator ${engines.validator}, boot ${engines.bootMs.duckdb} ms), Pyodide ${engines.versions.pyodide} + NumPy ${engines.versions.numpy} (boot ${engines.bootMs.pyodide} ms)`);
});

function deps(): ExorcistDeps {
  return {
    engine: { ...engines.deps, clock: { now: () => performance.timeOrigin + performance.now() } },
    hasher: { sha256: nodeSha256 },
    compressor: zlib,
    versions: { suture: '0.2.0', fastCheck: '4.10.3' },
  };
}

async function session(doc: SutureDocument): Promise<ExorcistSession> {
  const s = await createExorcistSession(doc, deps());
  if ('configError' in s) throw new Error(s.configError);
  return s;
}

/** Uniform over values (fc.double is uniform over float representations, which piles mass near 0 on small domains). */
function uniform(d: FuzzDomain): fc.Arbitrary<number> {
  if (d.kind === 'float') { const lo = d.min; const span = d.max - d.min; return fc.noBias(fc.integer({ min: 0, max: 2 ** 32 - 1 })).map((k) => lo + (span * k) / (2 ** 32 - 1)); }
  if (d.kind === 'integer') return fc.noBias(fc.integer({ min: d.min, max: d.max }));
  throw new Error('flagship inputs are numeric');
}

/** Fraction of uniform samples (fixed sampling seed) that violate the expected assertion: estimation + control (Req 10.3, 10.4). */
async function failingFraction(doc: SutureDocument, notes: WorkbookNotes, n: number, corrected: boolean): Promise<number> {
  const e = createWorkbookEngine(doc.workbook, engines.deps);
  if (corrected) e.applyEdits([{ kind: 'setCell', key: notes.control.cell, raw: notes.control.raw }]);
  await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
  const inputs = doc.exorcist.inputs;
  const samples = fc.sample(fc.tuple(...inputs.map((i) => uniform(i.domain))), { seed: 1, numRuns: n });
  const assertion = doc.exorcist.assertions.find((a) => a.id === notes.expectedAssertion);
  if (assertion === undefined || assertion.kind !== 'gte' || assertion.operand.kind !== 'const') throw new Error('expected a gte-const assertion');
  const bound = assertion.operand.value;
  let fails = 0;
  for (let off = 0; off < samples.length; off += 100) {
    const chunk = samples.slice(off, off + 100).map((vals) => inputs.map((inp, i) => ({ cell: inp.cell, value: vals[i] ?? 0 })));
    const res = await e.evaluateScenarioBatch({ scenarios: chunk, targets: [assertion.cell], tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED });
    for (const m of res.values) {
      const v: CellValue = m.get(assertion.cell) ?? null;
      if (typeof v !== 'number' || v < bound) fails++;
    }
  }
  return fails / samples.length;
}

async function baseValues(doc: SutureDocument, cells: ReadonlyArray<CellKey>): Promise<Map<CellKey, CellValue>> {
  const e = createWorkbookEngine(doc.workbook, engines.deps);
  await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
  return new Map(cells.map((c) => [c, e.getValue(c) as CellValue]));
}

const FLAGSHIPS = [
  { name: 'Flagship 1: SaaS Cash Runway', doc: saasRunwayDocument, notes: SAAS_NOTES, samples: 1000 },
  { name: 'Flagship 2: 100,000-Row E-Commerce Margin Audit', doc: ecommerceMarginDocument, notes: ECOMMERCE_NOTES, samples: 1000 },
] as const;

for (const f of FLAGSHIPS) {
  describe(f.name, () => {
    it('holds every assertion at the base case', async () => {
      const doc = f.doc();
      const cells = doc.exorcist.assertions.map((a) => a.cell);
      const values = await baseValues(doc, cells);
      const s = await session(doc);
      expect(s.mode).toBe('batched');
      for (const a of doc.exorcist.assertions) {
        const v = values.get(a.cell) ?? null;
        expect(typeof v, `${a.id} at base case`).toBe('number');
        if (a.kind === 'gte' && a.operand.kind === 'const') expect(v as number).toBeGreaterThanOrEqual(a.operand.value);
      }
    });

    it('estimation + control: the flaw fails ≥ 1 % of the domain; the corrected formula fails 0 %', async () => {
      const doc = f.doc();
      const flawed = await failingFraction(doc, f.notes, f.samples, false);
      const fixed = await failingFraction(doc, f.notes, f.samples, true);
      console.info(`[flagship] ${f.name}: failing fraction ${(flawed * 100).toFixed(1)} % (flawed) vs ${(fixed * 100).toFixed(1)} % (control) over ${f.samples} uniform samples`);
      expect(flawed).toBeGreaterThanOrEqual(0.01);
      expect(fixed).toBe(0);
    });

    it('Exorcist discovers and shrinks the flaw from a fresh unscripted seed, and replay reproduces it exactly', async () => {
      const doc = f.doc();
      const seed = crypto.getRandomValues(new Int32Array(1))[0] ?? 1;
      const t0 = performance.now();
      const verdict = await (await session(doc)).run({ seed, token: NEVER_CANCELLED, onProgress: () => undefined });
      const ms = Math.round(performance.now() - t0);
      expect(verdict.kind, `seed ${seed}`).toBe('violated');
      if (verdict.kind !== 'violated') return;
      const a = verdict.artifact;
      const va = a.violatedAssertion;
      const inputs = a.failingInputs.map((x) => `${x.cell}=${String(decodeScalar(x.value))}`).join(', ');
      console.info(`[flagship] ${f.name}: seed ${seed} → ${va.tier === 2 ? va.assertion.id : va.invariant} in ${ms} ms; shrunk ${inputs}; path ${a.path}; ${va.detail}`);
      expect(va.tier).toBe(2);
      if (va.tier === 2) expect(va.assertion.id).toBe(f.notes.expectedAssertion);
      expect(a.mode).toBe('batched');

      const fragment = await toReplayFragment(a, zlib);
      expect(typeof fragment).toBe('string');
      const decoded = typeof fragment === 'string' ? await fromReplayFragment(`#${fragment}`, zlib) : { error: 'too long' };
      expect(decoded).toEqual(a);
      const t1 = performance.now();
      const replay = await (await session(doc)).replay(a, NEVER_CANCELLED);
      console.info(`[flagship] ${f.name}: replay ${replay.kind}${replay.kind === 'reproduced' ? (replay.exact ? ' (exact)' : ' (direct)') : ''} in ${Math.round(performance.now() - t1)} ms`);
      expect(replay).toMatchObject({ kind: 'reproduced', exact: true });
    });
  });
}
