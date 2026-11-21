import { DEFAULT_EXORCIST, type SutureDocument } from '@suture/core';

/** An empty one-sheet workbook. Both engines stay Lazy until the first =SQL() or =PY() cell. */
export function blankDocument(): SutureDocument {
  return {
    format: 'suture.workbook',
    version: 1,
    title: 'Blank Workbook',
    workbook: { sheets: [{ name: 'Sheet1', cells: [] }], names: [], datasets: [], seed: 1 },
    exorcist: { ...DEFAULT_EXORCIST, inputs: [], assertions: [] },
  };
}
