import { decodeScalar, type CellErrorCode, type CellValue, type EncodedScalar, type ValueSummary } from '@suture/core';

/**
 * Cell values as plain JSON for the CLI and the MCP tools (Spec 05 §3.2). Scalars stay JSON scalars (numbers print in
 * JavaScript's shortest round-trip form); errors, tables, and matrices become one-key objects. Table bytes are never
 * serialized: a table is its row count and schema.
 */
export type JsonValue =
  | number | string | boolean | null
  | { readonly error: CellErrorCode; readonly message: string; readonly origin: string; readonly engine: 'formula' | 'sql' | 'py' }
  | { readonly table: { readonly rows: number; readonly columns: ReadonlyArray<string> } }
  | { readonly matrix: { readonly rows: number; readonly cols: number; readonly data: ReadonlyArray<number> | null } }
  | { readonly pending: true };

/** Matrices up to this many values carry their data; larger ones only their shape. */
export const MATRIX_DATA_LIMIT = 256;

export function toJson(v: CellValue | 'pending'): JsonValue {
  if (v === 'pending') return { pending: true };
  if (v === null || typeof v !== 'object') return v;
  switch (v.kind) {
    case 'error': return { error: v.code, message: v.message, origin: v.origin, engine: v.engine };
    case 'table': return { table: { rows: v.rowCount, columns: v.schema.map((f) => f.name) } };
    case 'matrix': return { matrix: { rows: v.rows, cols: v.cols, data: v.rows * v.cols <= MATRIX_DATA_LIMIT ? [...v.data] : null } };
  }
}

export function scalarJson(e: EncodedScalar): JsonValue {
  return decodeScalar(e);
}

export function summaryJson(s: ValueSummary): JsonValue {
  switch (s.kind) {
    case 'scalar': return decodeScalar(s.value);
    case 'error': return { error: s.code, message: s.message, origin: s.origin, engine: s.engine };
    case 'table': return { table: { rows: s.rowCount, columns: [...s.columns] } };
    case 'matrix': return { matrix: { rows: s.rows, cols: s.cols, data: null } };
  }
}
