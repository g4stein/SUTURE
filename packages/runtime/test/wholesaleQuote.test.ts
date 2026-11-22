import { describe, expect, it } from 'vitest';
import { openWorkbook } from '../src/headless/workbook.ts';
import { createNodeHeadless } from '../src/node/files.ts';
import { WHOLESALE_QUOTE_HASH, wholesaleQuoteDocument } from '../src/workbooks/index.ts';

/**
 * Spec 04 Req 7.6: the built-in copy of the Suture Crew sample must hash exactly like the file the Crew app audits, or
 * its replay links would ask for an import. The pinned hash is the `workbookHash` in `g4stein/suture-crew`
 * `tooling/fixtures/audit.json`, produced by `@g4stein/suture-mcp@0.1.0` from `samples/wholesale-quote.suture.json`.
 */
describe('the Suture Crew sample built-in', () => {
  it('hashes exactly like the Crew app sample (canonical form, as every host hashes it)', async () => {
    const { host } = createNodeHeadless();
    const wb = await openWorkbook('wholesale', 'flagship', wholesaleQuoteDocument(), true, host);
    expect(wb.hash).toBe(WHOLESALE_QUOTE_HASH);
    expect(wb.python).toBe('none');
    expect(wb.document.exorcist.assertions.map((a) => a.id)).toEqual(['net-price-positive', 'margin-at-most-100pct', 'margin-defined']);
  });
});
