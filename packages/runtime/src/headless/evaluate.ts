import { isCellError, type CellErrorCode, type CellKey } from '@suture/core';
import { toJson, type JsonValue } from './json.ts';
import { dialectOf, evaluatedEngine, infoOf, type Dialect, type HeadlessHost, type Workbook, type WorkbookInfo } from './workbook.ts';

export interface EvalReport {
  readonly format: 'suture.eval';
  readonly version: 1;
  readonly workbook: WorkbookInfo;
  /** Every non-empty cell, sheet by sheet in row-major order. */
  readonly cells: ReadonlyArray<{ readonly cell: CellKey; readonly dialect: Dialect; readonly value: JsonValue }>;
  readonly errors: ReadonlyArray<{ readonly cell: CellKey; readonly code: CellErrorCode; readonly message: string; readonly origin: string; readonly engine: 'formula' | 'sql' | 'py' }>;
  /** Members of each reference cycle (Spec 01 Req 9), in row-major order. */
  readonly cycles: ReadonlyArray<ReadonlyArray<CellKey>>;
}

/** Evaluates the whole cross-engine DAG against the host's real engines (Spec 05 Req 2.1). */
export async function evaluateWorkbook(wb: Workbook, host: HeadlessHost): Promise<EvalReport> {
  const { engine, result } = await evaluatedEngine(wb, host);
  const cells: Array<EvalReport['cells'][number]> = [];
  const errors: Array<EvalReport['errors'][number]> = [];
  for (const s of wb.document.workbook.sheets) {
    for (const c of s.cells) {
      const v = engine.getValue(c.key);
      cells.push({ cell: c.key, dialect: dialectOf(engine.getParsed(c.key)) ?? 'literal', value: toJson(v) });
      if (v !== 'pending' && isCellError(v)) errors.push({ cell: c.key, code: v.code, message: v.message, origin: v.origin, engine: v.engine });
    }
  }
  return { format: 'suture.eval', version: 1, workbook: infoOf(wb), cells, errors, cycles: result.cycles.map((c) => [...c.members]) };
}
