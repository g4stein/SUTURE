declare const cellKeyBrand: unique symbol;
/** Canonical "<sheet>!<COL><ROW>", e.g. "Sheet1!B7" or "'Q3 Plan'!B7". */
export type CellKey = string & { readonly [cellKeyBrand]: true };

export interface CellCoord {
  readonly sheet: string;
  readonly row: number; // 0-based, 0..1_048_575
  readonly col: number; // 0-based, 0..16_383
}

export interface RangeCoord {
  readonly sheet: string;
  readonly top: number;
  readonly left: number;
  readonly bottom: number; // inclusive, >= top
  readonly right: number; // inclusive, >= left
}

export type RefTarget =
  | { readonly kind: 'cell'; readonly coord: CellCoord }
  | { readonly kind: 'range'; readonly range: RangeCoord };

export interface NamedParameter {
  readonly name: string;
  readonly target: RefTarget;
}

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

const UNQUOTED_SHEET = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
const A1 = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;

export function columnLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function formatSheet(sheet: string): string {
  return UNQUOTED_SHEET.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`;
}

export function isValidSheetName(name: string): boolean {
  return name.length >= 1 && name.length <= 31 && !/[:\\/?*[\]]/.test(name);
}

export function toCellKey(c: CellCoord): CellKey {
  return `${formatSheet(c.sheet)}!${columnLetters(c.col)}${c.row + 1}` as CellKey;
}

export interface ParsedA1 {
  readonly col: number;
  readonly row: number;
  readonly absCol: boolean;
  readonly absRow: boolean;
}

/** Parses "A1", "$B$7" etc. Returns null when malformed or outside the grid. */
export function parseA1(text: string): ParsedA1 | null {
  const m = A1.exec(text);
  if (m === null) return null;
  const [, absC = '', letters = '', absR = '', digits = ''] = m;
  const col = columnIndex(letters);
  const row = Number(digits) - 1;
  if (col < 0 || col >= MAX_COLS || row < 0 || row >= MAX_ROWS) return null;
  return { col, row, absCol: absC === '$', absRow: absR === '$' };
}

/** Splits a "Sheet!A1" or "'My Sheet'!A1" prefix. Returns the sheet (unquoted) and the rest. */
export function splitSheetPrefix(text: string): { readonly sheet: string | null; readonly rest: string } | null {
  if (text.startsWith("'")) {
    let i = 1;
    let name = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === "'") {
        if (text[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += ch;
      i += 1;
    }
    if (text[i] !== "'" || text[i + 1] !== '!') return null;
    return { sheet: name, rest: text.slice(i + 2) };
  }
  const bang = text.indexOf('!');
  if (bang < 0) return { sheet: null, rest: text };
  return { sheet: text.slice(0, bang), rest: text.slice(bang + 1) };
}

export function parseCellKey(k: string): CellCoord | null {
  const split = splitSheetPrefix(k);
  if (split === null || split.sheet === null) return null;
  const a1 = parseA1(split.rest);
  if (a1 === null || a1.absCol || a1.absRow) return null;
  return { sheet: split.sheet, row: a1.row, col: a1.col };
}

export function normalizeRange(sheet: string, a: { row: number; col: number }, b: { row: number; col: number }): RangeCoord {
  return {
    sheet,
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

export function rangeContains(r: RangeCoord, c: CellCoord): boolean {
  return r.sheet.toUpperCase() === c.sheet.toUpperCase() && c.row >= r.top && c.row <= r.bottom && c.col >= r.left && c.col <= r.right;
}

export function compareRowMajor(a: CellCoord, b: CellCoord, sheetOrder: ReadonlyArray<string>): number {
  const sa = sheetIndex(sheetOrder, a.sheet);
  const sb = sheetIndex(sheetOrder, b.sheet);
  if (sa !== sb) return sa - sb;
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

function sheetIndex(order: ReadonlyArray<string>, sheet: string): number {
  const up = sheet.toUpperCase();
  const i = order.findIndex((s) => s.toUpperCase() === up);
  return i < 0 ? order.length : i;
}

export function formatA1(c: { row: number; col: number }, absCol = false, absRow = false): string {
  return `${absCol ? '$' : ''}${columnLetters(c.col)}${absRow ? '$' : ''}${c.row + 1}`;
}
