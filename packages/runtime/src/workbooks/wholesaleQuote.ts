import type { SutureDocument } from '@suture/core';
import sample from './wholesale-quote.suture.json';
import { validateDocument } from './validateDocument.ts';

/**
 * The Suture Crew sample workbook (`g4stein/suture-crew` `samples/wholesale-quote.suture.json`, copied byte for byte),
 * shipped as a built-in so the Crew app's "Open in Suture X-Ray" replay links open straight onto the grid: the web app
 * matches a link to a built-in by workbook hash (Spec 04 Req 7.3). Its DuckDB pricing query adds the three discounts
 * instead of compounding them, so a stacked quote prices at 0 and the margin divides by it. No Python cells.
 */
export const WHOLESALE_QUOTE_HASH = 'sha256:0941e701e46c85925a375911023405826f63f11ce8fd419376f39561f3163b3b';

export function wholesaleQuoteDocument(): SutureDocument {
  const check = validateDocument(sample);
  if (!check.ok) throw new Error(`wholesale-quote.suture.json: ${check.path} ${check.message}`);
  return check.document;
}
