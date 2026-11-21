import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkbookEngine, NEVER_CANCELLED, type CellKey, type SutureDocument } from '@suture/core';
import { PY_BLOCKED_MESSAGE } from '@suture/runtime/bridge';
import { ECOMMERCE_NOTES, SAAS_NOTES, saasRunwayDocument } from '@suture/runtime/workbooks';
import { nodeEngines } from '@suture/runtime/node';

/**
 * Spec 05 Req 2 — the compiled `suture` binary, end to end, against the real engines. Seeds come from the OS CSPRNG,
 * never from the test (the repository's flagship rule): each run asserts only verdicts, assertion ids, exit codes, and
 * that two runs with the same seed print the same JSON.
 */
const BIN = fileURLToPath(new URL('../dist/suture.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'suture-cli-'));

interface Run { readonly code: number; readonly stdout: string; readonly stderr: string }

function suture(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

type Json = Record<string, unknown>;
const parse = (r: Run): Json => JSON.parse(r.stdout) as Json;
const freshSeed = (): number => crypto.getRandomValues(new Int32Array(1))[0] ?? 1;

/** Everything except wall-clock values: `meta`, the artifact's `createdAt`, and the fragment that encodes it. */
function deterministic(r: Run): string {
  const j = parse(r);
  delete j['meta'];
  const replay = j['replay'] as { artifact: Json; fragment: unknown } | null;
  if (replay !== null) {
    delete replay.artifact['createdAt'];
    delete (replay as Partial<typeof replay>).fragment;
  }
  return JSON.stringify(j);
}

function withCell(doc: SutureDocument, cell: CellKey, raw: string): SutureDocument {
  return { ...doc, workbook: { ...doc.workbook, sheets: doc.workbook.sheets.map((s) => ({ ...s, cells: s.cells.map((c) => (c.key === cell ? { key: c.key, raw } : c)) })) } };
}

const flagshipFile = join(dir, 'runway.suture.json');
const fixedFile = join(dir, 'runway-fixed.suture.json');
beforeAll(() => {
  writeFileSync(flagshipFile, JSON.stringify(saasRunwayDocument()));
  writeFileSync(fixedFile, JSON.stringify(withCell(saasRunwayDocument(), SAAS_NOTES.control.cell, SAAS_NOTES.control.raw)));
});

describe('suture eval', () => {
  it('flagship:1 --json: exit 0, deterministic, values bit-identical to the in-process engines', async () => {
    const [a, b] = [await suture('eval', 'flagship:1', '--json'), await suture('eval', 'flagship:1', '--json')];
    expect(a.code, a.stderr).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    const r = parse(a) as { workbook: { python: string }; cells: Array<{ cell: string; dialect: string; value: unknown }>; errors: unknown[] };
    expect(r.workbook.python).toBe('trusted');
    expect(r.errors).toEqual([]);
    const dialect = Object.fromEntries(r.cells.map((c) => [c.cell, c.dialect]));
    expect([dialect['Cohorts!A3'], dialect['Model!B4'], dialect['Model!B5']]).toEqual(['sql', 'py', 'formula']);

    // Spec 02 task 9.1: the same handlers in this process give the same doubles, bit for bit.
    const engines = await nodeEngines();
    const e = createWorkbookEngine(saasRunwayDocument().workbook, engines.deps);
    await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
    for (const c of r.cells) {
      const v = e.getValue(c.cell as CellKey);
      if (typeof v === 'number') expect(Object.is(c.value, v), c.cell).toBe(true);
    }
  });

  it('flagship:2 --json: the 100,000-row Orders table and every margin cell evaluate without errors', async () => {
    const r = await suture('eval', 'flagship:2', '--json');
    expect(r.code, r.stderr).toBe(0);
    const j = parse(r) as { cells: Array<{ cell: string; value: unknown }>; errors: unknown[] };
    expect(j.errors).toEqual([]);
    expect(j.cells.find((c) => c.cell === 'Orders!A1')?.value).toMatchObject({ table: { rows: 100_000 } });
    expect(typeof j.cells.find((c) => c.cell === 'Margins!B5')?.value).toBe('number');
  });

  it('Python in a .suture.json file is blocked without --trust-python (Spec 05 Req 4)', async () => {
    const r = await suture('eval', flagshipFile, '--json');
    expect(r.code, r.stderr).toBe(0);
    const j = parse(r) as { workbook: { python: string }; cells: Array<{ cell: string; value: unknown }> };
    expect(j.workbook.python).toBe('blocked');
    expect(j.cells.find((c) => c.cell === 'Model!B4')?.value).toMatchObject({ error: '#PY!', message: PY_BLOCKED_MESSAGE });
    const trusted = parse(await suture('eval', flagshipFile, '--json', '--trust-python')) as { workbook: { python: string }; errors: unknown[] };
    expect(trusted.workbook.python).toBe('trusted');
    expect(trusted.errors).toEqual([]);
  });
});

describe('suture audit and replay', () => {
  it('flagship:1: exit 1, the expected assertion, identical JSON for the same seed, and an exact replay', async () => {
    const seed = String(freshSeed());
    const out = join(dir, 'f1.replay.json');
    const a = await suture('audit', 'flagship:1', '--seed', seed, '--json', '--out-replay', out);
    const b = await suture('audit', 'flagship:1', '--seed', seed, '--json');
    expect([a.code, b.code], a.stderr).toEqual([1, 1]);
    expect(deterministic(b)).toBe(deterministic(a));
    const j = parse(a) as { verdict: string; violation: { id: string }; lineage: Array<{ cell: string; dialect: string }>; failingEdge: unknown; tier2: Array<{ id: string; status: string }> };
    expect(j.verdict).toBe('violated');
    expect(j.violation.id).toBe(SAAS_NOTES.expectedAssertion);
    expect(j.tier2.find((t) => t.id === SAAS_NOTES.expectedAssertion)?.status).toBe('violated');
    expect(j.lineage.map((l) => l.dialect)).toEqual(expect.arrayContaining(['sql', 'py', 'formula']));
    expect(j.failingEdge).not.toBeNull();
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ format: 'suture.replay', version: 1, seed: Number(seed) });

    const replay = await suture('replay', out, '--json');
    expect(replay.code, replay.stderr).toBe(0);
    expect(parse(replay)).toMatchObject({ outcome: 'exact', violation: { id: SAAS_NOTES.expectedAssertion } });
    // The same artifact against a different workbook: wrong input, exit 2.
    expect((await suture('replay', out, '--workbook', 'flagship:2')).code).toBe(2);
  });

  it('flagship:2: exit 1 with the stacked-discount assertion, its lineage running through DuckDB and NumPy', async () => {
    const r = await suture('audit', 'flagship:2', '--seed', String(freshSeed()), '--json');
    expect(r.code, r.stderr).toBe(1);
    const j = parse(r) as { violation: { id: string }; lineage: Array<{ cell: string; dialect: string }> };
    expect(j.violation.id).toBe(ECOMMERCE_NOTES.expectedAssertion);
    expect(j.lineage.map((l) => l.cell)).toEqual(expect.arrayContaining(['Segments!A3', 'Margins!B5']));
  });

  it('a clean workbook passes: exit 0 with every Tier 1 invariant and Tier 2 assertion held', async () => {
    const r = await suture('audit', fixedFile, '--trust-python', '--seed', String(freshSeed()), '--json');
    expect(r.code, r.stderr).toBe(0);
    const j = parse(r) as { verdict: string; tier1: Array<{ status: string }>; tier2: Array<{ status: string }>; search: { runs: number } };
    expect(j.verdict).toBe('passed');
    expect(j.search.runs).toBe(1000);
    expect([...j.tier1, ...j.tier2].every((t) => t.status === 'held')).toBe(true);
  });
});

describe('suture inspect', () => {
  it('prints the dialect, parsed AST, precedents, dependents, and the topological chain', async () => {
    const r = await suture('inspect', 'flagship:1', '--cell', 'model!b5', '--json');
    expect(r.code, r.stderr).toBe(0);
    const j = parse(r) as { cell: string; dialect: string; raw: string; parsed: { kind: string; printed: string; ast: { t: string } }; precedents: string[]; dependents: string[]; upstream: string[]; chain: string[] };
    expect(j).toMatchObject({ cell: 'Model!B5', dialect: 'formula', raw: '=Inputs!B2/B4', parsed: { kind: 'formula', printed: '=Inputs!B2/B4', ast: { t: 'binary' } } });
    expect(j.precedents).toEqual(['Inputs!B2', 'Model!B4']);
    expect(j.dependents).toEqual(['Model!B6']);
    expect(j.upstream).toEqual(expect.arrayContaining(['Cohorts!A3', 'Model!B4', 'Inputs!B10']));
    expect(j.chain.slice(-3)).toEqual(['Model!B4', 'Model!B5', 'Model!B6']);
  });
});

describe('input and usage errors exit 2', () => {
  it.each([
    [['eval', join(dir, 'missing.suture.json')], 'no such file'],
    [['eval', 'flagship:9'], 'unknown flagship'],
    [['inspect', 'flagship:1', '--cell', 'Nowhere!A1'], 'no sheet named'],
    [['inspect', 'flagship:1'], '--cell'],
    [['audit', 'flagship:1', '--seed', 'abc'], '--seed'],
    [['transmogrify', 'flagship:1'], 'unknown command'],
    [['eval'], 'missing'],
  ])('%j', async (args, message) => {
    const r = await suture(...args);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
  });
});
