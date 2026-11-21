/** Spec 04 §6.1 — file routing by extension. */
export type ImportKind = 'csv' | 'parquet' | 'xlsx' | 'suture' | 'replay';

export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

/** `.suture.json` is a workbook document; any other `.json` is treated as a replay artifact (validated on read). */
export function importKind(fileName: string): ImportKind | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.suture.json')) return 'suture';
  if (n.endsWith('.json')) return 'replay';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.parquet')) return 'parquet';
  if (n.endsWith('.xlsx')) return 'xlsx';
  return null;
}

export type ImportCheck = { readonly ok: true; readonly kind: ImportKind } | { readonly ok: false; readonly reason: string };

export function checkImport(fileName: string, size: number): ImportCheck {
  const kind = importKind(fileName);
  if (kind === null) return { ok: false, reason: `${fileName}: unsupported file type (use .csv, .parquet, .xlsx, .suture.json, or a replay .json)` };
  if (size > MAX_IMPORT_BYTES) return { ok: false, reason: `${fileName}: ${(size / 2 ** 20).toFixed(0)} MiB is larger than the 256 MiB import limit` };
  return { ok: true, kind };
}
