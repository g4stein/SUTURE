import type { SutureDocument } from '@suture/core';
import type { WorkbookNotes } from './build.ts';
import { ECOMMERCE_NOTES, ecommerceMarginDocument } from './ecommerceMargin.ts';
import { SAAS_NOTES, saasRunwayDocument } from './saasRunway.ts';

export type FlagshipId = 'flagship:1' | 'flagship:2';

export interface Flagship {
  readonly id: FlagshipId;
  readonly summary: string;
  readonly make: () => SutureDocument;
  readonly notes: WorkbookNotes;
}

/** The built-in workbooks, addressable as `flagship:1` and `flagship:2` from the CLI and the MCP server. */
export const FLAGSHIPS: ReadonlyArray<Flagship> = [
  {
    id: 'flagship:1', make: saasRunwayDocument, notes: SAAS_NOTES,
    summary: 'Cash runway: DuckDB cohort trajectory, NumPy OLS burn projection, formula runway and status.',
  },
  {
    id: 'flagship:2', make: ecommerceMarginDocument, notes: ECOMMERCE_NOTES,
    summary: '100,000 synthetic orders in DuckDB, NumPy pivots, formula margins across five sheets.',
  },
];

export function flagshipById(ref: string): Flagship | null {
  return FLAGSHIPS.find((f) => f.id === ref.trim().toLowerCase()) ?? null;
}
