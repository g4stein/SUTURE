import { DEFAULT_EXORCIST, type SutureDocument } from '@suture/core';
import { cellKey, sheet, str, type WorkbookNotes } from './build.ts';

/**
 * Flagship 2 — 100,000-Row E-Commerce Margin Audit (Spec 04 §7.2, batched mode).
 *
 * DAG (cached upstream of Params, then parameterized downstream):
 *   Orders!A1   DuckDB synthesizes 100,000 orders from range(100000) + the suture_u01 / suture_normal hash PRNG. Computed once.
 *   Segments!A1 DuckDB collapses the 100,000 rows into a 96-row category × base-discount × promo × loyalty tier table
 *               (orders, units, gross, cost). Computed once; it does not depend on Params.
 *   Segments!A3 DuckDB stress SQL over the tier table, parameterized by Params (promo, loyalty, cap, cost shock). Because
 *               the discount is constant inside a tier, Σ q·p·(1−d) − Σ q·c·shock − n·ship over the tier equals the per-order
 *               scan exactly (up to float summation order), so each fuzz scenario reads 96 rows, not 100,000.
 *   Model!B2    NumPy pivots the stress table into an 8 × 2 matrix (stacked-cohort margin and revenue per category).
 *   Model!B3    NumPy weighted OLS of margin % on stacked discount + category effects; projects Electronics at the maximum
 *               stacked discount and counts cohort anomalies (|z| > 2).
 *   Cohorts     Category and segment literals; INDEX into Model!B2.
 *   Margins     Executive KPIs with SUMIFS / AVERAGEIF / IF / VLOOKUP over a literal margin-floor policy table.
 *
 * The flaw (Segments!A3): the cap is applied to each discount separately instead of to the stacked total, so a promo +
 * loyalty order can receive base + cap + cap. At the base case the Hardlines stacked cohort is comfortably profitable.
 */
const S_PA = 'Params';
const S_OR = 'Orders';
const S_SE = 'Segments';
const S_CO = 'Cohorts';
const S_MO = 'Model';
const S_MA = 'Margins';

export const CATEGORIES = ['Electronics', 'Home', 'Sports', 'Toys', 'Apparel', 'Beauty', 'Grocery', 'Books'] as const;
const SEGMENT: Readonly<Record<(typeof CATEGORIES)[number], string>> = {
  Electronics: 'Hardlines', Home: 'Hardlines', Sports: 'Hardlines', Toys: 'Hardlines', Apparel: 'Softlines', Beauty: 'Softlines', Grocery: 'Consumables', Books: 'Consumables',
};

export const ORDERS_SQL = `WITH base AS (
  SELECT i,
         1 + CAST(floor(suture_u01(i, 1) * 8) AS INTEGER) AS ci,
         round(exp(3.2 + 0.9 * suture_normal(i, 3)), 2) AS lp
  FROM range(100000) t(i)
)
SELECT i AS order_id,
       list_extract(['Electronics','Home','Apparel','Beauty','Sports','Toys','Grocery','Books'], ci) AS category,
       CASE WHEN suture_u01(i, 2) < 0.55 THEN 'NA' WHEN suture_u01(i, 2) < 0.85 THEN 'EU' ELSE 'APAC' END AS region,
       lp AS list_price,
       round(lp * least(0.70, greatest(0.20,
             list_extract([0.58, 0.48, 0.38, 0.42, 0.50, 0.45, 0.60, 0.55], ci) + 0.03 * suture_normal(i, 5))), 2) AS unit_cost,
       1 + CAST(floor(suture_u01(i, 6) * 4) AS INTEGER) AS quantity,
       list_extract([0.0, 0.05, 0.10], 1 + CAST(floor(suture_u01(i, 7) * 3) AS INTEGER)) AS base_discount,
       suture_u01(i, 8) < 0.30 AS has_promo,
       suture_u01(i, 9) < 0.25 AS is_loyal,
       DATE '2026-01-01' + CAST(floor(suture_u01(i, 10) * 365) AS INTEGER) AS order_date
FROM base
ORDER BY i`;

export const TIERS_SQL = `SELECT category, base_discount, has_promo, is_loyal,
       count(*)::DOUBLE AS orders,
       sum(quantity)::DOUBLE AS units,
       sum(quantity * list_price) AS gross,
       sum(quantity * unit_cost) AS cost
FROM {{Orders!A1}}
GROUP BY ALL
ORDER BY category, base_discount, has_promo, is_loyal`;

/** Flawed: each discount is capped separately (least(x, cap) + least(y, cap) + …) instead of least(x + y + …, cap). */
export const STRESS_SQL = `SELECT category,
       CASE WHEN has_promo AND is_loyal THEN 'stacked' WHEN has_promo THEN 'promo' WHEN is_loyal THEN 'loyal' ELSE 'none' END AS cohort,
       sum(gross * (1 - d)) AS revenue,
       sum(gross * (1 - d) - cost * {{Params!B6}}::DOUBLE - orders * {{Params!B5}}::DOUBLE) AS margin,
       sum(gross * d) / sum(gross) AS stacked_discount
FROM (
  SELECT *,
         least(base_discount, {{Params!B4}}::DOUBLE)
       + CASE WHEN has_promo THEN least({{Params!B2}}::DOUBLE, {{Params!B4}}::DOUBLE) ELSE 0 END
       + CASE WHEN is_loyal THEN least({{Params!B3}}::DOUBLE, {{Params!B4}}::DOUBLE) ELSE 0 END AS d
  FROM {{Segments!A1}}
)
GROUP BY ALL
ORDER BY category, cohort`;

export const STRESS_SQL_FIXED = STRESS_SQL.replace(
  `least(base_discount, {{Params!B4}}::DOUBLE)
       + CASE WHEN has_promo THEN least({{Params!B2}}::DOUBLE, {{Params!B4}}::DOUBLE) ELSE 0 END
       + CASE WHEN is_loyal THEN least({{Params!B3}}::DOUBLE, {{Params!B4}}::DOUBLE) ELSE 0 END AS d`,
  `least(base_discount
       + CASE WHEN has_promo THEN {{Params!B2}}::DOUBLE ELSE 0 END
       + CASE WHEN is_loyal THEN {{Params!B3}}::DOUBLE ELSE 0 END, {{Params!B4}}::DOUBLE) AS d`,
);

export const PIVOT_PY = `t = inputs['Segments!A3']
cats = ${JSON.stringify(CATEGORIES)}
cat = np.array(t['category'], dtype=object)
coh = np.array(t['cohort'], dtype=object)
out = np.zeros((len(cats), 2))
for i, c in enumerate(cats):
    sel = (cat == c) & (coh == 'stacked')
    out[i, 0] = float(t['margin'][sel].sum())
    out[i, 1] = float(t['revenue'][sel].sum())
out`;

export const MODEL_PY = `t = inputs['Segments!A3']
cap = inputs['Params!B4']
cats = np.array(t['category'], dtype=object)
names = np.unique(cats)
rev = t['revenue']
pct = t['margin'] / rev
disc = t['stacked_discount']
X = np.column_stack([np.ones_like(disc), disc] + [(cats == c).astype(np.float64) for c in names[1:]])
w = np.sqrt(rev / rev.sum())
beta = np.linalg.lstsq(X * w[:, None], pct * w, rcond=None)[0]
resid = pct - X @ beta
z = (resid - resid.mean()) / resid.std()
x = np.zeros(X.shape[1]); x[0] = 1.0
x[1] = 0.10 + 2.0 * cap
k = int(np.searchsorted(names, 'Electronics'))
if k > 0: x[1 + k] = 1.0
np.array([[float(x @ beta), float(np.count_nonzero(np.abs(z) > 2.0))]])`;

export const TOTAL_MARGIN_SQL = 'SELECT sum(margin) FROM {{Segments!A3}}';

export function ecommerceMarginDocument(): SutureDocument {
  const k = (s: string, a1: string) => cellKey(s, a1);
  const cohorts: Record<string, string> = { A1: 'Category', B1: 'Segment', C1: 'Stacked margin', D1: 'Stacked revenue', E1: 'Stacked margin %' };
  CATEGORIES.forEach((c, i) => {
    const r = i + 2;
    cohorts[`A${r}`] = c;
    cohorts[`B${r}`] = SEGMENT[c];
    cohorts[`C${r}`] = `=INDEX(Model!B2, ${i + 1}, 1)`;
    cohorts[`D${r}`] = `=INDEX(Model!B2, ${i + 1}, 2)`;
    cohorts[`E${r}`] = `=C${r}/D${r}`;
  });
  return {
    format: 'suture.workbook',
    version: 1,
    title: '100,000-Row E-Commerce Margin Audit',
    workbook: {
      sheets: [
        sheet(S_PA, {
          A1: 'Parameter', B1: 'Value',
          A2: 'Promo discount', B2: '0.10',
          A3: 'Loyalty discount', B3: '0.05',
          A4: 'Discount cap (policy)', B4: '0.25',
          A5: 'Shipping cost per order', B5: '3.5',
          A6: 'Unit cost shock ×', B6: '1',
        }),
        sheet(S_OR, { A1: `=SQL(${str(ORDERS_SQL)})` }),
        sheet(S_SE, { A1: `=SQL(${str(TIERS_SQL)})`, A3: `=SQL(${str(STRESS_SQL)})` }),
        sheet(S_CO, cohorts),
        sheet(S_MO, {
          A2: 'Stacked cohort pivot (8 × 2)', B2: `=PY(${str(PIVOT_PY)})`,
          A3: 'Weighted OLS: [projected Electronics margin % at max stack, anomalies]', B3: `=PY(${str(MODEL_PY)})`,
        }),
        sheet(S_MA, {
          A2: 'Total margin', B2: `=SQL(${str(TOTAL_MARGIN_SQL)})`,
          A3: 'Stacked-cohort margin', B3: '=SUM(Cohorts!C2:C9)',
          A4: 'Hardlines stacked margin', B4: '=SUMIFS(Cohorts!C2:C9,Cohorts!B2:B9,"Hardlines")',
          A5: 'Hardlines stacked net margin %', B5: '=B4/SUMIFS(Cohorts!D2:D9,Cohorts!B2:B9,"Hardlines")',
          A6: 'Average stacked margin % (Softlines)', B6: '=AVERAGEIF(Cohorts!B2:B9,"Softlines",Cohorts!E2:E9)',
          A7: 'Hardlines margin floor (policy)', B7: '=VLOOKUP("Hardlines",D11:E13,2,FALSE)',
          A8: 'Discount policy status', B8: '=IF(B5<B7,"BREACH","OK")',
          A9: 'Model: projected Electronics margin % at max stack', B9: '=INDEX(Model!B3,1,1)',
          A10: 'Model: cohort anomalies (|z| > 2)', B10: '=INDEX(Model!B3,1,2)',
          D10: 'Segment', E10: 'Margin floor',
          D11: 'Hardlines', E11: '0.05', D12: 'Softlines', E12: '0.12', D13: 'Consumables', E13: '0.03',
        }),
      ],
      names: [],
      datasets: [],
      seed: 4102,
    },
    exorcist: {
      ...DEFAULT_EXORCIST,
      batchSize: 100,
      maxBatches: 10,
      maxShrinkRounds: 12, // 12 rounds narrow the four discount inputs; decimal simplification finishes the job
      inputs: [
        { cell: k(S_PA, 'B2'), domain: { kind: 'float', min: 0, max: 0.35 } },
        { cell: k(S_PA, 'B3'), domain: { kind: 'float', min: 0, max: 0.20 } },
        { cell: k(S_PA, 'B4'), domain: { kind: 'float', min: 0.15, max: 0.30 } },
        { cell: k(S_PA, 'B6'), domain: { kind: 'float', min: 0.95, max: 1.10 } },
      ],
      assertions: [
        { id: 'hardlines-stacked-net-margin', cell: k(S_MA, 'B5'), kind: 'gte', operand: { kind: 'const', value: 0 } },
        { id: 'total-margin-not-null', cell: k(S_MA, 'B2'), kind: 'notNull' },
        { id: 'model-projection-finite', cell: k(S_MA, 'B9'), kind: 'finite' },
      ],
    },
  };
}

export const ECOMMERCE_NOTES: WorkbookNotes = {
  flaw: 'Segments!A3 caps each discount separately, so a promo + loyalty order can receive base + cap + cap instead of at most the policy cap.',
  control: {
    cell: cellKey(S_SE, 'A3'),
    raw: `=SQL(${str(STRESS_SQL_FIXED)})`,
    explanation: 'Apply the cap to the stacked total: least(base + promo + loyalty, cap).',
  },
  expectedAssertion: 'hardlines-stacked-net-margin',
};
