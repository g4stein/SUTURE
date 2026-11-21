import { toCellKey, type CellKey, type CellSource } from '@suture/core';

export function cellKey(sheet: string, a1: string): CellKey {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  if (m === null) throw new Error(`bad A1 reference ${a1}`);
  let col = 0;
  for (const ch of m[1] ?? '') col = col * 26 + ch.charCodeAt(0) - 64;
  return toCellKey({ sheet, row: Number(m[2]) - 1, col: col - 1 });
}

/** Formula string literal: the only escape is a doubled quote (Spec 01 §5.2). */
export function str(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

export function sheet(name: string, cells: Record<string, string>): { readonly name: string; readonly cells: ReadonlyArray<CellSource> } {
  return { name, cells: Object.entries(cells).map(([a1, raw]) => ({ key: cellKey(name, a1), raw })) };
}

export interface WorkbookNotes {
  /** The realistic flaw, in one sentence. */
  readonly flaw: string;
  /** The corrected formula or SQL, applied as an edit by the control test (Spec 04 Req 10.4). */
  readonly control: { readonly cell: CellKey; readonly raw: string; readonly explanation: string };
  readonly expectedAssertion: string;
}
