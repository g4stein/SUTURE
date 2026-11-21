/** Spec 02 Req 5.4: lowercase, non-alphanumerics → "_", "_" before a leading digit, "_2", "_3", … on collision. */
export function sanitizeDatasetName(fileName: string, existing: ReadonlyArray<string>): string {
  const base = fileName.replace(/\.(csv|parquet|xlsx|suture\.json)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
  const stem = (/^[0-9]/.test(base) ? `_${base}` : base).slice(0, 56);
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}_${i}`)) return `${stem}_${i}`;
}
