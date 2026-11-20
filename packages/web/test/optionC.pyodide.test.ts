import { readFileSync } from 'node:fs';
import { Bool, Float64, Int32, Int64, Table, Utf8, tableToIPC, vectorFromArray } from 'apache-arrow';
import { loadPyodide, type PyodideAPI } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { columnSpecs } from '../src/workers/arrowColumns.ts';

/** Real Pyodide + NumPy in Node, running the exact bridge module the Pyodide worker runs (Spec 02 §4.3 Option C). */
let py: PyodideAPI;
type Proxy = { get(i: number): unknown; length: number; toJs(): unknown; destroy(): void };

beforeAll(async () => {
  py = await loadPyodide({ stdout: () => undefined, stderr: () => undefined });
  await py.loadPackage(['numpy'], { messageCallback: () => undefined });
  py.runPython(readFileSync(new URL('../src/workers/python/suture_bridge.py', import.meta.url), 'utf8'));
  const loaded = Object.keys(py.loadedPackages);
  console.info(`[option-c] Pyodide ${py.version}; loaded packages: ${loaded.join(', ')}`);
}, 240_000);

function table(): Table {
  const half = (xs: Array<number | null>) => xs;
  const t1 = new Table({
    f: vectorFromArray(half([1.5, null, 3.25]), new Float64()),
    i: vectorFromArray([1, 2, 3], new Int32()),
    big: vectorFromArray([10n, -20n, 9007199254740993n], new Int64()),
    b: vectorFromArray([true, false, null], new Bool()),
    s: vectorFromArray(['α', null, 'gamma'], new Utf8()),
  });
  const t2 = new Table({
    f: vectorFromArray([4.0, 5.0], new Float64()),
    i: vectorFromArray([4, 5], new Int32()),
    big: vectorFromArray([1n, 2n], new Int64()),
    b: vectorFromArray([true, true], new Bool()),
    s: vectorFromArray(['d', 'e'], new Utf8()),
  });
  return t1.concat(t2); // two record batches → two chunks per column
}

function run(code: string, binding: unknown): Proxy {
  const fn = py.globals.get('run_batch') as (...a: unknown[]) => Proxy;
  return fn(code, false, 7, [], [[{ key: 't', value: binding }]], '<cell Slice!B1>');
}

describe('Option C: apache-arrow views → JsBuffer.assign_to → NumPy', () => {
  it('decodes without copying in JS and with exactly one memcpy per column buffer in Python', () => {
    const ipc = tableToIPC(table(), 'stream');
    const specs = columnSpecs(ipc);
    if (!specs.ok) throw new Error('unsupported column');
    for (const c of specs.columns) for (const ch of c.chunks) expect(ch.data.buffer, `${c.name} view shares the IPC buffer`).toBe(ipc.buffer);
    const before = Number((py.globals.get('assign_count') as () => number)());
    const out = run(
      [
        "t = inputs['t']",
        "f, i, big, b, s = t['f'], t['i'], t['big'], t['b'], t['s']",
        "np.array([[float(f.sum()), float(np.ma.count_masked(f)), float(i.sum()), float(big[2] - 9007199254740992), float(b[:2].sum()), float(len(s)), float(s[1] is None)]])",
      ].join('\n'),
      { kind: 'table', columns: specs.columns },
    );
    const item = out.get(0) as Proxy;
    expect(item.get(0)).toBe('mat');
    const arr = item.get(3) as { toJs(): { get?: unknown } } & Proxy;
    const values = Array.from((arr.toJs() as ArrayLike<ArrayLike<number>>)[0] ?? []);
    expect(values).toEqual([1.5 + 3.25 + 4 + 5, 1, 15, 1, 1, 5, 1]);
    const copies = Number((py.globals.get('assign_count') as () => number)()) - before;
    // chunk 1: f data+validity (2), i data (1), big data (1), b data+validity (2), s offsets+data+validity (3) = 9
    // chunk 2: no nulls → f, i, big, b data (4) + s offsets+data (2) = 6. Exactly one assign_to per buffer.
    expect(copies).toBe(9 + 6);
    arr.destroy();
    item.destroy();
    out.destroy();
  });

  it('maps Python failures to cell errors with division evidence', () => {
    const cases: Array<[string, string]> = [
      ['1/0', '#DIV/0!'],
      ["inputs['missing']", '#PY!'],
      ["raise ValueError('boom')", '#PY!'],
      ['2**60', '#NUM!'],
    ];
    for (const [code, expected] of cases) {
      const out = run(code, { kind: 'scalar', type: 'number', value: 1 });
      const item = out.get(0) as Proxy;
      expect([item.get(0), item.get(1)], code).toEqual(['err', expected]);
      item.destroy();
      out.destroy();
    }
    // WebAssembly exposes no floating-point exception flags, so NumPy's errstate callback never fires in Pyodide:
    // a NumPy 1/0 yields +inf with no division evidence, which the boundary normalizes to #NUM! (steering rule 3).
    const div = run('np.array([1.0]) / 0', { kind: 'scalar', type: 'null', value: 0 });
    const d = div.get(0) as Proxy;
    expect(d.get(0)).toBe('mat');
    expect(d.get(4)).toBe(false);
    d.destroy();
    div.destroy();
  });

  it('runs each scenario in a fresh namespace', () => {
    const fn = py.globals.get('run_batch') as (...a: unknown[]) => Proxy;
    const out = fn("globals().setdefault('leak', 0) + 1", false, 1, [], [[], []], '<cell>');
    const a = out.get(0) as Proxy;
    const b = out.get(1) as Proxy;
    expect([a.get(1), b.get(1)]).toEqual([1, 1]);
    a.destroy();
    b.destroy();
    out.destroy();
  });
});
