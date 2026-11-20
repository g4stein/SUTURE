import * as fc from 'fast-check';
import { CELL_ERROR_CODES, columnLetters, formatA1, normalizeRange, withRequiredParens, type BinaryOp, type FormulaAst } from '../index.ts';

export const SHEET = 'Sheet1';
const OPS: BinaryOp[] = ['^', '*', '/', '+', '-', '&', '=', '<>', '<', '>', '<=', '>='];

const cellRef = fc.record({ row: fc.integer({ min: 0, max: 49 }), col: fc.integer({ min: 0, max: 25 }), absCol: fc.boolean(), absRow: fc.boolean() });

export const refAst: fc.Arbitrary<FormulaAst> = fc.oneof(
  cellRef.map((c) => ({
    t: 'ref' as const,
    ref: { kind: 'cell' as const, coord: { sheet: SHEET, row: c.row, col: c.col }, text: formatA1(c, c.absCol, c.absRow) },
    abs: { col: c.absCol, row: c.absRow, col2: false, row2: false },
  })),
  fc.tuple(cellRef, cellRef).map(([a, b]) => ({
    t: 'ref' as const,
    ref: { kind: 'range' as const, range: normalizeRange(SHEET, a, b), text: `${formatA1(a, a.absCol, a.absRow)}:${formatA1(b, b.absCol, b.absRow)}` },
    abs: { col: a.absCol, row: a.absRow, col2: b.absCol, row2: b.absRow },
  })),
);

const leaf: fc.Arbitrary<FormulaAst> = fc.oneof(
  fc.double({ min: 0, max: 1e300, noNaN: true, noDefaultInfinity: true }).filter((v) => !Object.is(v, -0)).map((v) => ({ t: 'num' as const, v })),
  fc.integer({ min: 0, max: 1000 }).map((v) => ({ t: 'num' as const, v })),
  fc.string({ maxLength: 8, unit: 'grapheme' }).map((v) => ({ t: 'str' as const, v })),
  fc.boolean().map((v) => ({ t: 'bool' as const, v })),
  fc.constantFrom(...CELL_ERROR_CODES).map((code) => ({ t: 'err' as const, code })),
  fc.stringMatching(/^n_[a-z]{1,6}$/).map((name) => ({ t: 'name' as const, name })),
  refAst,
);

const fnName = fc.oneof(fc.constantFrom('SUM', 'AVERAGE', 'MAX', 'ROUND', 'IF', 'IFERROR', 'ISERROR', 'IFNA', 'VLOOKUP'), fc.stringMatching(/^[A-Z]{2,6}$/));

/** Arbitrary formula ASTs, normalized so that printing is unambiguous (Spec 01 Req 5.4). */
export const formulaAst: fc.Arbitrary<FormulaAst> = fc
  .letrec<{ node: FormulaAst }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.record({ op: fc.constantFrom<'+' | '-'>('+', '-'), arg: tie('node') }).map((r) => ({ t: 'unary' as const, op: r.op, arg: r.arg })),
      tie('node').map((arg) => ({ t: 'percent' as const, arg })),
      fc.record({ op: fc.constantFrom(...OPS), left: tie('node'), right: tie('node') }).map((r) => ({ t: 'binary' as const, op: r.op, left: r.left, right: r.right })),
      fc.record({ fn: fnName, args: fc.array(tie('node'), { maxLength: 3 }) }).map((r) => ({ t: 'call' as const, fn: r.fn, args: r.args })),
      tie('node').map((arg) => ({ t: 'paren' as const, arg })),
    ),
  }))
  .node.map(withRequiredParens);

/** Error-free arithmetic over small integers for the fast-formula-parser differential (both oracles agree here). */
export const safeArith: fc.Arbitrary<string> = fc
  .letrec<{ e: string }>((tie) => ({
    e: fc.oneof(
      { depthSize: 'small' },
      fc.integer({ min: 1, max: 99 }).map(String),
      fc.tuple(tie('e'), fc.constantFrom('+', '-', '*'), tie('e')).map(([a, op, b]) => `(${a}${op}${b})`),
      fc.tuple(tie('e'), fc.integer({ min: 1, max: 9 })).map(([a, d]) => `(${a}/${d})`),
      fc.tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 0, max: 4 })).map(([b, n]) => `(${b}^${n})`),
      tie('e').map((a) => `-${a}`),
      tie('e').map((a) => `(${a}%)`), // the oracle cannot parse a double postfix percent ("1%%")
      fc.array(tie('e'), { minLength: 1, maxLength: 4 }).map((xs) => `SUM(${xs.join(',')})`),
      fc.array(tie('e'), { minLength: 1, maxLength: 4 }).map((xs) => `AVERAGE(${xs.join(',')})`),
      fc.tuple(tie('e'), tie('e'), tie('e')).map(([c, a, b]) => `IF(${c}>0,${a},${b})`),
    ),
  }))
  .e;

export function a1(row: number, col: number): string {
  return `${columnLetters(col)}${row + 1}`;
}
