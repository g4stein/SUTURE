import { DEFAULT_EXORCIST, type SutureDocument } from '@suture/core';
import { cellKey, sheet, str, type WorkbookNotes } from './build.ts';

/**
 * Flagship 1 — SaaS Cash Runway & Unit Economics (Spec 04 §7.1, batched mode).
 *
 * Cohorts!A1 (DuckDB, cached, no inputs): 12 monthly signup cohorts with deterministic intake noise (suture_u01).
 * Cohorts!A3 (DuckDB, per scenario): the 12-month operating trajectory — legacy MRR decaying with churn, each cohort's
 *   survivors (churn × churn shock), gross profit, S&M spend, and opex growing 2 %/month with hiring — all bound
 *   prepared-statement parameters from Inputs.
 * Model!B4 (NumPy): OLS trend of monthly net burn, projected to month 13.
 * Model!B5: runway = cash / projected net burn, unguarded — the realistic flaw. A company that turns profitable
 *   (net burn ≤ 0) gets a negative runway or #DIV/0!, and Model!B6 tells it to "RAISE NOW".
 */
const S_IN = 'Inputs';
const S_CO = 'Cohorts';
const S_MO = 'Model';

export const COHORT_BASE_SQL = `SELECT m AS cohort_month,
       0.85 + 0.30 * suture_u01(m, 11) AS intake_factor
FROM range(1, 13) t(m)
ORDER BY m`;

export const TRAJECTORY_SQL = `WITH p AS (
  SELECT {{Inputs!B3}}::DOUBLE AS mrr0, {{Inputs!B4}}::DOUBLE AS new_logos, {{Inputs!B5}}::DOUBLE AS arpa,
         {{Inputs!B6}}::DOUBLE * {{Inputs!B10}}::DOUBLE AS churn, {{Inputs!B7}}::DOUBLE AS cac, {{Inputs!B8}}::DOUBLE AS margin,
         {{Inputs!B9}}::DOUBLE AS opex0
),
months AS (SELECT t FROM range(1, 13) r(t)),
survivors AS (
  SELECT months.t, sum(p.new_logos * c.intake_factor * pow(1 - p.churn, months.t - c.cohort_month)) AS customers,
         sum(CASE WHEN c.cohort_month = months.t THEN p.new_logos * c.intake_factor ELSE 0 END) AS new_customers
  FROM months, p, {{Cohorts!A1}} c
  WHERE c.cohort_month <= months.t
  GROUP BY months.t
)
SELECT s.t AS month,
       (p.mrr0 * pow(1 - p.churn, s.t) + p.arpa * s.customers) * p.margin AS gross_profit,
       s.new_customers * p.cac AS sm_spend,
       p.opex0 * pow(1.02, s.t) AS opex,
       p.opex0 * pow(1.02, s.t) + s.new_customers * p.cac - (p.mrr0 * pow(1 - p.churn, s.t) + p.arpa * s.customers) * p.margin AS net_burn
FROM survivors s, p
ORDER BY s.t`;

export const BURN_PY = `t = inputs['Cohorts!A3']
m = t['month'].astype(np.float64)
y = t['net_burn']
X = np.column_stack([np.ones_like(m), m])
beta = np.linalg.lstsq(X, y, rcond=None)[0]
float(beta[0] + beta[1] * 13.0)`;

export function saasRunwayDocument(): SutureDocument {
  const k = (s: string, a1: string) => cellKey(s, a1);
  return {
    format: 'suture.workbook',
    version: 1,
    title: 'SaaS Cash Runway & Unit Economics',
    workbook: {
      sheets: [
        sheet(S_IN, {
          A1: 'Driver', B1: 'Value',
          A2: 'Cash on hand', B2: '6000000',
          A3: 'Starting MRR', B3: '300000',
          A4: 'New customers / month', B4: '30',
          A5: 'ARPA (monthly)', B5: '1500',
          A6: 'Monthly logo churn', B6: '0.025',
          A7: 'Blended CAC', B7: '9000',
          A8: 'Gross margin', B8: '0.78',
          A9: 'Opex excl. S&M (monthly)', B9: '450000',
          A10: 'Churn shock ×', B10: '1',
        }),
        sheet(S_CO, {
          A1: `=SQL(${str(COHORT_BASE_SQL)})`,
          A3: `=SQL(${str(TRAJECTORY_SQL)})`,
        }),
        sheet(S_MO, {
          A2: 'Gross profit (month 0)', B2: '=Inputs!B3*Inputs!B8',
          A3: 'S&M spend (monthly)', B3: '=Inputs!B4*Inputs!B7',
          A4: 'Projected net burn (OLS, month 13)', B4: `=PY(${str(BURN_PY)})`,
          A5: 'Runway (months)', B5: '=Inputs!B2/B4',
          A6: 'Runway status', B6: '=IF(B5<12,"RAISE NOW",IF(B5<18,"PLAN RAISE","OK"))',
          A7: 'Net new MRR', B7: '=Inputs!B4*Inputs!B5-Inputs!B3*Inputs!B6*Inputs!B10',
          A8: 'LTV', B8: '=Inputs!B5*Inputs!B8/(Inputs!B6*Inputs!B10)',
          A9: 'LTV / CAC', B9: '=B8/Inputs!B7',
          A10: 'CAC payback (months)', B10: '=Inputs!B7/(Inputs!B5*Inputs!B8)',
        }),
      ],
      names: [],
      datasets: [],
      seed: 4101,
    },
    exorcist: {
      ...DEFAULT_EXORCIST,
      batchSize: 100,
      maxBatches: 10,
      maxShrinkRounds: 32, // eight inputs shrink slowly; 32 rounds + decimal simplification keeps discovery interactive
      inputs: [
        { cell: k(S_IN, 'B3'), domain: { kind: 'float', min: 150_000, max: 450_000 } },
        { cell: k(S_IN, 'B4'), domain: { kind: 'integer', min: 5, max: 60 } },
        { cell: k(S_IN, 'B5'), domain: { kind: 'float', min: 900, max: 2400 } },
        { cell: k(S_IN, 'B6'), domain: { kind: 'float', min: 0.005, max: 0.08 } },
        { cell: k(S_IN, 'B7'), domain: { kind: 'float', min: 4000, max: 14000 } },
        { cell: k(S_IN, 'B8'), domain: { kind: 'float', min: 0.70, max: 0.85 } },
        { cell: k(S_IN, 'B9'), domain: { kind: 'float', min: 300_000, max: 600_000 } },
        { cell: k(S_IN, 'B10'), domain: { kind: 'float', min: 0.25, max: 3 } },
      ],
      assertions: [
        { id: 'runway-non-negative', cell: k(S_MO, 'B5'), kind: 'gte', operand: { kind: 'const', value: 0 } },
        { id: 'runway-defined', cell: k(S_MO, 'B5'), kind: 'notError' },
        { id: 'runway-finite', cell: k(S_MO, 'B5'), kind: 'finite' },
      ],
    },
  };
}

export const SAAS_NOTES: WorkbookNotes = {
  flaw: 'Model!B5 divides cash by projected net burn with no guard, so a company that turns profitable gets a negative runway (or #DIV/0!) and is told to RAISE NOW.',
  control: {
    cell: cellKey(S_MO, 'B5'),
    raw: '=IF(B4<=0,120,Inputs!B2/B4)',
    explanation: 'Cap runway at 120 months when the company is not burning cash; IF short-circuits, so the division never runs when B4 ≤ 0.',
  },
  expectedAssertion: 'runway-non-negative',
};
