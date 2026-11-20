import { tableFromIPC, type Data } from 'apache-arrow';

/** Spec 02 §4.4 — Arrow IPC → typed-array views (no copy) for the Python bridge. */
export type BridgeDtype =
  | 'float64' | 'float32'
  | 'int8' | 'int16' | 'int32' | 'int64'
  | 'uint8' | 'uint16' | 'uint32' | 'uint64'
  | 'bool' | 'utf8' | 'date32' | 'timestamp_us';

type View = Int8Array | Int16Array | Int32Array | BigInt64Array | Uint8Array | Uint16Array | Uint32Array | BigUint64Array | Float32Array | Float64Array;

export interface ColumnChunkSpec {
  readonly length: number;
  readonly data: View;
  readonly bitOffset: number;
  readonly hasValidity: boolean;
  readonly validity: Uint8Array;
  readonly validityBitOffset: number;
  readonly offsets: Int32Array;
}

export interface ColumnSpec {
  readonly name: string;
  readonly dtype: BridgeDtype;
  readonly length: number;
  readonly chunks: ReadonlyArray<ColumnChunkSpec>;
}

export type ColumnSpecResult =
  | { readonly ok: true; readonly columns: ReadonlyArray<ColumnSpec> }
  | { readonly ok: false; readonly column: string; readonly arrowType: string };

function dtypeOf(typeName: string): BridgeDtype | null {
  switch (typeName) {
    case 'Float64': return 'float64';
    case 'Float32': return 'float32';
    case 'Int8': return 'int8';
    case 'Int16': return 'int16';
    case 'Int32': return 'int32';
    case 'Int64': return 'int64';
    case 'Uint8': return 'uint8';
    case 'Uint16': return 'uint16';
    case 'Uint32': return 'uint32';
    case 'Uint64': return 'uint64';
    case 'Bool': return 'bool';
    case 'Utf8': return 'utf8';
    case 'Date32<DAY>': return 'date32';
    case 'Timestamp<MICROSECOND>': return 'timestamp_us';
    default: return null;
  }
}

const EMPTY_U8 = new Uint8Array(0);
const EMPTY_I32 = new Int32Array(0);

function chunkSpec(d: Data, dtype: BridgeDtype): ColumnChunkSpec {
  const hasValidity = d.nullCount > 0 && d.nullBitmap !== undefined && d.nullBitmap.length > 0;
  const validity = hasValidity ? (d.nullBitmap as Uint8Array) : EMPTY_U8;
  if (dtype === 'utf8') {
    const offsets = (d.valueOffsets as Int32Array).subarray(d.offset, d.offset + d.length + 1);
    const start = offsets[0] ?? 0;
    const end = offsets[d.length] ?? start;
    return { length: d.length, data: (d.values as Uint8Array).subarray(start, end), bitOffset: 0, hasValidity, validity, validityBitOffset: d.offset, offsets };
  }
  if (dtype === 'bool') {
    return { length: d.length, data: d.values as Uint8Array, bitOffset: d.offset, hasValidity, validity, validityBitOffset: d.offset, offsets: EMPTY_I32 };
  }
  const values = d.values as View;
  const stride = dtype === 'date32' ? 1 : 1;
  const view = values.subarray(d.offset * stride, (d.offset + d.length) * stride) as View;
  return { length: d.length, data: view, bitOffset: 0, hasValidity, validity, validityBitOffset: d.offset, offsets: EMPTY_I32 };
}

/** Views share the IPC buffer: decoding copies nothing (the one memcpy happens in Python via assign_to). */
export function columnSpecs(ipc: Uint8Array): ColumnSpecResult {
  const table = tableFromIPC(ipc);
  const columns: ColumnSpec[] = [];
  for (let i = 0; i < table.numCols; i++) {
    const field = table.schema.fields[i];
    const col = table.getChildAt(i);
    if (field === undefined || col === null) continue;
    const dtype = dtypeOf(String(field.type));
    if (dtype === null) return { ok: false, column: field.name, arrowType: String(field.type) };
    columns.push({ name: field.name, dtype, length: col.length, chunks: col.data.map((d) => chunkSpec(d, dtype)) });
  }
  return { ok: true, columns };
}
