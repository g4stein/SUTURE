import type { CellKey } from './address.ts';

export type EngineId = 'formula' | 'sql' | 'py';

export type CellErrorCode =
  | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A'
  | '#CYCLE!' | '#NUM!' | '#SQL!' | '#PY!' | '#TIMEOUT!';

export interface CellError {
  readonly kind: 'error';
  readonly code: CellErrorCode;
  /** Human-readable cause. Never shown as the cell's value, only in inspectors. */
  readonly message: string;
  /** Address of the cell where the error originated (not where it propagated to). */
  readonly origin: string;
  readonly engine: EngineId;
}

export interface ArrowField {
  readonly name: string;
  /** Arrow type as reported by apache-arrow, e.g. "Float64", "Int64", "Utf8", "Bool". */
  readonly arrowType: string;
  readonly nullable: boolean;
}

export interface TableRef {
  readonly kind: 'table';
  /** Arrow IPC stream bytes. This Uint8Array owns its whole ArrayBuffer. */
  readonly ipc: Uint8Array;
  readonly schema: ReadonlyArray<ArrowField>;
  readonly rowCount: number;
}

export interface Matrix2D {
  readonly kind: 'matrix';
  readonly rows: number;
  readonly cols: number;
  /** Row-major, length === rows * cols, every element finite. */
  readonly data: Float64Array;
}

export type CellValue =
  | number
  | string
  | boolean
  | null
  | TableRef
  | Matrix2D
  | CellError;

/** Scalar subset used for literals, SQL parameters, fuzz inputs, and overrides. */
export type ScalarValue = number | string | boolean | null;

export const CELL_ERROR_CODES: ReadonlyArray<CellErrorCode> = [
  '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A',
  '#CYCLE!', '#NUM!', '#SQL!', '#PY!', '#TIMEOUT!',
];

export function isCellError(v: CellValue): v is CellError {
  return typeof v === 'object' && v !== null && v.kind === 'error';
}

export function isScalar(v: CellValue): v is ScalarValue {
  return v === null || typeof v !== 'object';
}

export function makeError(code: CellErrorCode, message: string, origin: CellKey | string, engine: EngineId): CellError {
  return { kind: 'error', code, message, origin, engine };
}
