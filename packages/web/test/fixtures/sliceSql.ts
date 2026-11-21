/**
 * SQL from the retired Phase 2 vertical-slice workbook, kept as a Node test fixture for `slice.duckdb.test.ts`
 * (deterministic macros, 10,000-row synthesis, prepared-statement bindings). The workbook itself is no longer in the app;
 * its end-to-end coverage moved to Journey 3 (`e2e/journeys.spec.ts`).
 */

/** E1: a deterministic 10,000-order dataset synthesized from range(10000) + the suture_u01 hash PRNG. */
export const E1_SQL = `SELECT i AS order_id,
       1 + CAST(floor(suture_u01(i, 1) * 12) AS INTEGER) AS month,
       (80 + 40 * suture_u01(i, 2)) * (1 + 0.02 * (1 + floor(suture_u01(i, 1) * 12))) AS revenue,
       (95 + 30 * suture_u01(i, 3)) * (1 + 0.01 * (1 + floor(suture_u01(i, 1) * 12))) AS cost,
       suture_u01(i, 4) AS churn_draw
FROM range(10000) t(i)
ORDER BY i`;

/** A1: aggregates E1 into 12 monthly revenue/cost rows; {{C2}} (churn shock) is a bound prepared-statement parameter. */
export const A1_SQL = `SELECT month,
       sum(CASE WHEN churn_draw < 0.08 * {{C2}} THEN 0 ELSE revenue END) AS revenue,
       sum(cost) AS cost
FROM {{E1}}
GROUP BY month
ORDER BY month`;
