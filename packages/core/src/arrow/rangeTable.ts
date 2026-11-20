import { Bool, Float64, Utf8, makeVector, tableFromIPC, tableToIPC, Table, vectorFromArray } from 'apache-arrow';
import { columnLetters } from '../model/address.ts';
import type { ArrowField, ScalarValue, TableRef } from '../model/values.ts';

/** Returns a Uint8Array that owns its whole ArrayBuffer (copying only when needed). */
export function owned(view: Uint8Array): Uint8Array {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
}

export function schemaOf(table: Table): ArrowField[] {
  return table.schema.fields.map((f) => ({ name: f.name, arrowType: String(f.type), nullable: f.nullable }));
}

export function tableRefFromTable(table: Table): TableRef {
  const ipc = owned(tableToIPC(table, 'stream'));
  return { kind: 'table', ipc, schema: schemaOf(table), rowCount: table.numRows };
}

export function tableRefFromIPC(bytes: Uint8Array): TableRef {
  const ipc = owned(bytes);
  const t = tableFromIPC(ipc);
  return { kind: 'table', ipc, schema: schemaOf(t), rowCount: t.numRows };
}

/** Range → table: columns named by column letters; DOUBLE / BOOLEAN / VARCHAR per column (Spec 01 §7.3). */
export function rangeToTableRef(rows: number, cols: number, left: number, values: ReadonlyArray<ScalarValue>): TableRef {
  const columns: Record<string, ReturnType<typeof makeVector>> = {};
  for (let c = 0; c < cols; c++) {
    const col: ScalarValue[] = [];
    for (let r = 0; r < rows; r++) col.push(values[r * cols + c] ?? null);
    const name = columnLetters(left + c);
    if (col.every((v) => v === null || typeof v === 'number')) {
      columns[name] = vectorFromArray(col as Array<number | null>, new Float64());
    } else if (col.every((v) => v === null || typeof v === 'boolean')) {
      columns[name] = vectorFromArray(col as Array<boolean | null>, new Bool());
    } else {
      columns[name] = vectorFromArray(
        col.map((v) => (v === null ? null : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))),
        new Utf8(),
      );
    }
  }
  return tableRefFromTable(new Table(columns));
}
