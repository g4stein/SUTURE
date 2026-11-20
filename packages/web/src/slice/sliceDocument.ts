import { DEFAULT_EXORCIST, toCellKey, type CellKey, type SutureDocument } from '@suture/core';

export const SHEET = 'Slice';
export const k = (a1: string): CellKey => {
  const m = /^([A-Z])(\d+)$/.exec(a1);
  if (m === null) throw new Error(a1);
  return toCellKey({ sheet: SHEET, row: Number(m[2]) - 1, col: (m[1] ?? 'A').charCodeAt(0) - 65 });
};

/**
 * E1 — DuckDB: a deterministic 10,000-order dataset synthesized from range(10000) + the suture_u01 hash PRNG
 * (Spec 04 determinism rule). It depends on no fuzz input, so it is computed once and shared by every scenario.
 */
export const E1_SQL = `SELECT i AS order_id,
       1 + CAST(floor(suture_u01(i, 1) * 12) AS INTEGER) AS month,
       (80 + 40 * suture_u01(i, 2)) * (1 + 0.02 * (1 + floor(suture_u01(i, 1) * 12))) AS revenue,
       (95 + 30 * suture_u01(i, 3)) * (1 + 0.01 * (1 + floor(suture_u01(i, 1) * 12))) AS cost,
       suture_u01(i, 4) AS churn_draw
FROM range(10000) t(i)
ORDER BY i`;

/**
 * A1 — DuckDB: aggregates the 10,000 orders of E1 into 12 monthly revenue/cost rows (Arrow IPC). The churn shock
 * {{C2}} is a bound prepared-statement parameter: orders whose churn draw falls under 8% × C2 lose their revenue.
 */
export const A1_SQL = `SELECT month,
       sum(CASE WHEN churn_draw < 0.08 * {{C2}} THEN 0 ELSE revenue END) AS revenue,
       sum(cost) AS cost
FROM {{E1}}
GROUP BY month
ORDER BY month`;

/** B1 — NumPy: OLS trend of monthly net burn (cost − revenue), projected to month 13. Receives A1 via Option C. */
export const B1_PY = `t = inputs['A1']
m = t['month'].astype(np.float64)
burn = t['cost'] - t['revenue']
X = np.column_stack([np.ones_like(m), m])
beta = np.linalg.lstsq(X, burn, rcond=None)[0]
float(beta[0] + beta[1] * 13.0)`;

function formulaString(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

export function sliceDocument(): SutureDocument {
  return {
    format: 'suture.workbook',
    version: 1,
    title: 'Vertical slice: SQL → NumPy → runway',
    workbook: {
      sheets: [{
        name: SHEET,
        cells: [
          { key: k('A1'), raw: `=SQL(${formulaString(A1_SQL)})` },
          { key: k('E1'), raw: `=SQL(${formulaString(E1_SQL)})` },
          { key: k('B1'), raw: `=PY(${formulaString(B1_PY)})` },
          { key: k('C1'), raw: '250000' },
          { key: k('C2'), raw: '1' },
          // Unguarded runway: the realistic modeling flaw. Profitable months (net burn ≤ 0) give a negative runway or #DIV/0!.
          { key: k('D1'), raw: '=C1/B1' },
        ],
      }],
      names: [],
      datasets: [],
      seed: 20261120,
    },
    exorcist: {
      ...DEFAULT_EXORCIST,
      batchSize: 100,
      maxBatches: 10,
      inputs: [
        { cell: k('C1'), domain: { kind: 'float', min: 10_000, max: 2_000_000 } },
        { cell: k('C2'), domain: { kind: 'float', min: 0, max: 3 } },
      ],
      assertions: [
        { id: 'runway-finite', cell: k('D1'), kind: 'finite' },
        { id: 'runway-defined', cell: k('D1'), kind: 'notError' },
        { id: 'runway-non-negative', cell: k('D1'), kind: 'gte', operand: { kind: 'const', value: 0 } },
      ],
    },
  };
}
