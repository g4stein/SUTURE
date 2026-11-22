import { decodeScalar, type CellAssertion, type CellKey, type CellValue, type EncodedScalar, type UniversalInvariantId, type ValueSummary } from '@suture/core';

/** Up to 12 significant digits; exponent notation outside [1e-6, 1e15) (Spec 04 §3). Display never changes stored values. */
export function formatNumber(n: number): string {
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 1e-6 || a >= 1e15) return n.toExponential(6).replace(/\.?0+e/, 'e');
  return String(Number(n.toPrecision(12)));
}

export function formatValue(v: CellValue | 'pending' | undefined): string {
  if (v === undefined || v === 'pending') return '…';
  if (v === null) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (v.kind === 'error') return v.code;
  if (v.kind === 'matrix') return `matrix ${v.rows}×${v.cols}`;
  return `table ${v.rowCount.toLocaleString('en-US')}×${v.schema.length}`;
}

/** Compact badge text for a TableRef cell: `100,000 × 6`. */
export function tableBadge(rowCount: number, cols: number): string {
  return `${rowCount.toLocaleString('en-US')} × ${cols}`;
}

export function formatScalar(e: EncodedScalar): string {
  const v = decodeScalar(e);
  if (v === null) return 'blank';
  return typeof v === 'number' ? formatNumber(v) : String(v);
}

export function formatSummary(s: ValueSummary): string {
  switch (s.kind) {
    case 'scalar': return formatScalar(s.value);
    case 'error': return s.code;
    case 'matrix': return `matrix ${s.rows}×${s.cols}`;
    case 'table': return `table ${s.rowCount.toLocaleString('en-US')}×${s.columns.length}`;
  }
}

/**
 * ASCII operators: the Unicode `≥` / `≤` signs are missing from some monospace fonts and rendered as blank space next to
 * the operand, so every host prints `>=` / `<=` (identical in the browser, the CLI, and MCP output).
 */
const LABELS: Readonly<Record<CellAssertion['kind'], string>> = { finite: 'finite', notError: 'not error', notNull: 'not null', gte: '>=', lte: '<=', gt: '>', lt: '<', between: 'between', monotonicWith: 'monotonic with' };

/** The rule an assertion states, as the Audit Studio and the CLI print it: `>= 0`, `between 0 and Model!B2`. */
export function assertionLabel(a: CellAssertion): string {
  const op = (o: { readonly kind: 'const'; readonly value: number } | { readonly kind: 'cell'; readonly cell: CellKey }): string => (o.kind === 'const' ? String(o.value) : o.cell);
  switch (a.kind) {
    case 'gte': case 'lte': case 'gt': case 'lt': return `${LABELS[a.kind]} ${op(a.operand)}`;
    case 'between': return `between ${op(a.min)} and ${op(a.max)}`;
    case 'monotonicWith': return `${a.direction === 'nonDecreasing' ? 'non-decreasing' : 'non-increasing'} in ${a.input}`;
    default: return LABELS[a.kind];
  }
}

/** Spec 03 Tier 1: the universal invariants every Exorcist run checks, in check order. */
export const TIER1_INVARIANTS: ReadonlyArray<{ readonly id: UniversalInvariantId; readonly label: string }> = [
  { id: 'T1.noUnhandledException', label: 'no kernel throws' },
  { id: 'T1.noNonFiniteLeak', label: 'no NaN or ±Infinity reaches a cell' },
  { id: 'T1.strictErrorPropagation', label: 'errors propagate strictly from their origin' },
  { id: 'T1.editOrderDeterminism', label: 'results do not depend on edit order' },
  { id: 'T1.crossEngineTolerance', label: 'SQL and NumPy agree within 1e-9 (batched)' },
];
