import type { CellKey } from '../model/address.ts';
import { CELL_ERROR_CODES, makeError, type CellError, type CellErrorCode } from '../model/values.ts';

const DIRECT = new Set<string>(['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!']);

export function errorCodeFromLiteral(raw: string): CellErrorCode | null {
  const up = raw.trim().toUpperCase();
  if ((CELL_ERROR_CODES as ReadonlyArray<string>).includes(up)) return up as CellErrorCode;
  if (up === '#NULL!') return '#VALUE!';
  if (up === '#SPILL!') return '#REF!';
  return null;
}

/** Maps a library error string (formulajs / fast-formula-parser) onto the canonical set. */
export function mapLibraryError(raw: string, origin: CellKey): CellError {
  const up = raw.trim().toUpperCase();
  if (DIRECT.has(up)) return makeError(up as CellErrorCode, raw, origin, 'formula');
  if (up === '#NULL!') return makeError('#VALUE!', raw, origin, 'formula');
  if (up === '#SPILL!') return makeError('#REF!', raw, origin, 'formula');
  return makeError('#VALUE!', `library error: ${raw}`, origin, 'formula');
}
