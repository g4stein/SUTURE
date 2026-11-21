import { RecordBatchReader } from 'apache-arrow';
import type { TableRef } from '@suture/core';

export const PREVIEW_ROW_LIMIT = 100;

export interface TablePreview {
  readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** Rows actually decoded on the main thread (Spec 04 Req 3.3: at most the first 100). */
  readonly decoded: number;
  readonly total: number;
}

function cellText(v: unknown, type: string): string {
  if (v === null || v === undefined) return '';
  // apache-arrow returns Date32/Date64 values as epoch milliseconds.
  if (typeof v === 'number' && type.startsWith('Date')) return new Date(v).toISOString().slice(0, 10);
  if (typeof v === 'number' && type.startsWith('Timestamp')) return new Date(v).toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * Decodes only the first `limit` rows: record batches are read one at a time and reading stops as soon as the limit
 * is reached, so a 100,000-row result never materializes on the main thread.
 */
export function previewTable(ref: TableRef, limit = PREVIEW_ROW_LIMIT): TablePreview {
  const columns = ref.schema.map((f) => ({ name: f.name, type: f.arrowType }));
  const rows: string[][] = [];
  const reader = RecordBatchReader.from(ref.ipc);
  for (const batch of reader) {
    const take = Math.min(batch.numRows, limit - rows.length);
    const vectors = columns.map((_, i) => batch.getChildAt(i));
    for (let r = 0; r < take; r++) rows.push(vectors.map((vec, i) => cellText(vec?.get(r), columns[i]?.type ?? '')));
    if (rows.length >= limit) break;
  }
  reader.cancel();
  return { columns, rows, decoded: rows.length, total: ref.rowCount };
}
