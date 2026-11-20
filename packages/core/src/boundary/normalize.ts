import { tableFromIPC, type Table } from 'apache-arrow';
import type { CellKey } from '../model/address.ts';
import { makeError, type CellError, type CellValue, type EngineId, type Matrix2D, type TableRef } from '../model/values.ts';

export type DivisionEvidence = 'divisionByZero' | 'none';

export class InvariantViolation extends Error {
  readonly invariant: string;
  constructor(invariant: string, message: string) {
    super(`${invariant}: ${message}`);
    this.name = 'InvariantViolation';
    this.invariant = invariant;
  }
}

export function normalizeNumber(x: number, evidence: DivisionEvidence, origin: CellKey, engine: EngineId): number | CellError {
  if (Number.isNaN(x)) return makeError('#NUM!', 'result is not a number (NaN)', origin, engine);
  if (x === Infinity || x === -Infinity) {
    return evidence === 'divisionByZero'
      ? makeError('#DIV/0!', 'division by zero', origin, engine)
      : makeError('#NUM!', 'result is not finite', origin, engine);
  }
  return x;
}

export function normalizeMatrix(m: Matrix2D, evidence: DivisionEvidence, origin: CellKey, engine: EngineId): Matrix2D | CellError {
  if (m.data.length !== m.rows * m.cols) return makeError('#VALUE!', 'matrix shape does not match its data', origin, engine);
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i] ?? 0;
    if (!Number.isFinite(v)) {
      const e = normalizeNumber(v, evidence, origin, engine);
      return typeof e === 'number' ? makeError('#NUM!', 'matrix element is not finite', origin, engine) : e;
    }
  }
  return m;
}

const FLOAT_TYPES = new Set(['Float', 'Float16', 'Float32', 'Float64']);

export function decodeTable(t: TableRef): Table {
  return tableFromIPC(t.ipc);
}

/** Scans every floating-point column; any NaN/±Infinity turns the whole cell into #NUM!. */
export function normalizeTable(t: TableRef, origin: CellKey, engine: EngineId): TableRef | CellError {
  const table = decodeTable(t);
  for (const field of table.schema.fields) {
    if (!FLOAT_TYPES.has(String(field.type))) continue;
    const col = table.getChild(field.name);
    if (col === null) continue;
    for (const chunk of col.data) {
      const values = chunk.values as ArrayLike<number>;
      for (let i = 0; i < chunk.length; i++) {
        if (!chunk.getValid(i)) continue;
        const v = values[chunk.offset + i] ?? 0;
        if (!Number.isFinite(v)) return makeError('#NUM!', `column "${field.name}" contains a non-finite value`, origin, engine);
      }
    }
  }
  return t;
}

export function safeIntegerOrError(x: bigint, origin: CellKey, engine: EngineId): number | CellError {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (x > max || x < -max) return makeError('#NUM!', 'integer exceeds 2^53-1', origin, engine);
  return Number(x);
}

/** 1 row × 1 column collapses to a scalar; anything else stays a TableRef. */
export function collapseSqlResult(t: TableRef, origin: CellKey): CellValue {
  if (t.rowCount !== 1 || t.schema.length !== 1) return t;
  const table = decodeTable(t);
  const field = table.schema.fields[0];
  if (field === undefined) return t;
  const col = table.getChild(field.name);
  if (col === null) return t;
  const v: unknown = col.get(0);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return normalizeNumber(v, 'none', origin, 'sql');
  if (typeof v === 'bigint') return safeIntegerOrError(v, origin, 'sql');
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  return makeError('#VALUE!', `cannot collapse a ${String(field.type)} value to a scalar`, origin, 'sql');
}

export function assertCanonical(v: CellValue): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new InvariantViolation('T1.noNonFiniteLeak', `raw ${String(v)} reached the DAG`);
    return;
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  switch (v.kind) {
    case 'error':
      return;
    case 'matrix':
      if (v.data.length !== v.rows * v.cols) throw new InvariantViolation('T1.noNonFiniteLeak', 'matrix shape mismatch');
      for (const x of v.data) if (!Number.isFinite(x)) throw new InvariantViolation('T1.noNonFiniteLeak', 'non-finite matrix element');
      return;
    case 'table':
      if (v.ipc.byteOffset !== 0 || v.ipc.byteLength !== v.ipc.buffer.byteLength) {
        throw new InvariantViolation('T1.noNonFiniteLeak', 'TableRef bytes do not own their buffer');
      }
      return;
  }
}
