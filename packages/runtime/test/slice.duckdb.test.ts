import { tableFromIPC } from 'apache-arrow';
import { queryIPC } from '../src/engines/duckdbIpc.ts';
import { lowbias32 } from '@suture/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection } from 'duckdb-wasm-blocking';
import { A1_SQL, E1_SQL } from './fixtures/sliceSql.ts';
import { MACROS } from '../src/engines/duckdbHandler.ts';
import { openNodeDuckDB } from '../src/node/engines.ts';

let conn: DuckDBConnection;
beforeAll(async () => {
  conn = (await openNodeDuckDB()).conn;
  for (const m of ['SET threads = 1', 'SET preserve_insertion_order = true', ...MACROS]) conn.query(m);
  const e1 = queryIPC(conn, E1_SQL, [], () => false);
  if (e1 === 'cancelled') throw new Error('cancelled');
  conn.insertArrowFromIPCStream(e1, { name: 'orders_e1', create: true });
  conn.query('CREATE OR REPLACE TEMP VIEW __suture_b0 AS SELECT * FROM orders_e1');
});

const sql = A1_SQL.replace('{{C2}}', '$1').replace('{{E1}}', '__suture_b0');

function monthly(c2: number): { month: number[]; revenue: number[]; cost: number[]; ipc: Uint8Array } {
  const ipc = queryIPC(conn, sql, [c2], () => false);
  if (ipc === 'cancelled') throw new Error('cancelled');
  const t = tableFromIPC(ipc);
  const col = (n: string): number[] => Array.from(t.getChild(n)?.toArray() as ArrayLike<number>, Number);
  return { month: col('month'), revenue: col('revenue'), cost: col('cost'), ipc };
}

/** Same OLS as B1 (intercept + slope on month), projected to month 13 — in plain TS for cross-checking. */
function projectedBurn(c2: number): number {
  const { month, revenue, cost } = monthly(c2);
  const y = month.map((_m, i) => (cost[i] ?? 0) - (revenue[i] ?? 0));
  const n = month.length;
  const mx = month.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  month.forEach((x, i) => { sxy += (x - mx) * ((y[i] ?? 0) - my); sxx += (x - mx) ** 2; });
  const slope = sxy / sxx;
  return my - slope * mx + slope * 13;
}

describe('slice dataset (A1) in real DuckDB-WASM', () => {
  it('suture_h32 is bit-identical to core lowbias32 on 10,000 inputs', () => {
    const t = conn.query('SELECT i, suture_h32(i) AS h FROM range(10000) t(i)');
    const h = t.getChild('h')?.toArray() as BigUint64Array;
    for (let i = 0; i < 10000; i++) expect(Number(h[i])).toBe(lowbias32(i));
  });

  it('aggregates 10,000 synthesized orders into 12 months, deterministically', () => {
    const a = monthly(1);
    const b = monthly(1);
    expect(a.month).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Buffer.from(a.ipc).equals(Buffer.from(b.ipc))).toBe(true);
    const count = conn.query('SELECT count(*) AS n FROM orders_e1').getChild('n')?.get(0);
    expect(Number(count)).toBe(10000);
  });

  it('the unguarded runway has a real cliff: base case burns cash, low churn shock turns net burn negative', () => {
    const base = projectedBurn(1);
    expect(base).toBeGreaterThan(0); // at C2 = 1 the company burns cash → runway = C1 / burn is positive
    expect(projectedBurn(0)).toBeLessThan(0); // at C2 = 0 retained revenue exceeds cost → runway goes negative
    // Locate the sign change: fraction of the fuzz domain [0, 3] where the assertion D1 >= 0 fails.
    let failing = 0;
    const N = 120;
    for (let i = 0; i <= N; i++) if (projectedBurn((3 * i) / N) <= 0) failing++;
    const fraction = failing / (N + 1);
    console.info(`[slice] projected burn at C2=1: ${base.toFixed(2)}; failing fraction of C2 ∈ [0,3]: ${(fraction * 100).toFixed(1)}%`);
    expect(fraction).toBeGreaterThan(0.01);
    expect(fraction).toBeLessThan(0.5);
  });
});
