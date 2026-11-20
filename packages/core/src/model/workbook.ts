import type { CellKey, NamedParameter } from './address.ts';
import type { ArrowField, ScalarValue } from './values.ts';

export type CellDialect = 'literal' | 'formula' | 'sql' | 'py';

export interface CellSource {
  readonly key: CellKey;
  readonly raw: string;
  /** Present only for cells written by setLiteral; takes precedence over parsing raw. */
  readonly literal?: ScalarValue;
}

export interface SheetDefinition {
  readonly name: string;
  readonly cells: ReadonlyArray<CellSource>;
}

export interface DatasetMeta {
  readonly name: string;
  readonly format: 'csv' | 'parquet' | 'xlsx';
  readonly sha256: string;
  readonly byteLength: number;
  readonly rowCount: number;
  readonly schema: ReadonlyArray<ArrowField>;
}

export interface WorkbookDefinition {
  readonly sheets: ReadonlyArray<SheetDefinition>;
  readonly names: ReadonlyArray<NamedParameter>;
  readonly datasets: ReadonlyArray<DatasetMeta>;
  readonly seed: number;
}

export type Edit =
  | { readonly kind: 'setCell'; readonly key: CellKey; readonly raw: string }
  | { readonly kind: 'setLiteral'; readonly key: CellKey; readonly value: ScalarValue }
  | { readonly kind: 'clearCell'; readonly key: CellKey }
  | { readonly kind: 'setName'; readonly param: NamedParameter }
  | { readonly kind: 'removeName'; readonly name: string }
  | { readonly kind: 'addSheet'; readonly name: string }
  | { readonly kind: 'removeSheet'; readonly name: string }
  | { readonly kind: 'registerDataset'; readonly meta: DatasetMeta }
  | { readonly kind: 'dropDataset'; readonly name: string };

/** Display text for a literal written by setLiteral. */
export function literalDisplay(v: ScalarValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  return v;
}
