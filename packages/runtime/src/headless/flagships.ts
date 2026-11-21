import { FLAGSHIPS, flagshipById, type Flagship } from '../workbooks/registry.ts';
import { openWorkbook, type HeadlessHost, type Workbook } from './workbook.ts';

/** Opens a built-in flagship (`flagship:1` / `flagship:2`); its Python always runs. */
export function openFlagship(ref: string, host: HeadlessHost): Promise<Workbook> | null {
  const f = flagshipById(ref);
  return f === null ? null : openWorkbook(f.id, 'flagship', f.make(), true, host);
}

/** The built-in flagship a replay artifact was recorded on, found by its workbook hash. */
export async function flagshipForHash(hash: string, host: HeadlessHost): Promise<{ readonly flagship: Flagship; readonly workbook: Workbook } | null> {
  for (const f of FLAGSHIPS) {
    const wb = await openWorkbook(f.id, 'flagship', f.make(), true, host);
    if (wb.hash === hash) return { flagship: f, workbook: wb };
  }
  return null;
}
