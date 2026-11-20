import type { CellCoord, NamedParameter, RangeCoord } from '../model/address.ts';
import type { CellErrorCode } from '../model/values.ts';

export type ResolvedRef =
  | { readonly kind: 'cell'; readonly coord: CellCoord; readonly text: string }
  | { readonly kind: 'range'; readonly range: RangeCoord; readonly text: string }
  | { readonly kind: 'unresolved'; readonly text: string; readonly code: '#REF!' | '#NAME?' };

export interface AbsFlags {
  readonly col: boolean;
  readonly row: boolean;
  readonly col2: boolean;
  readonly row2: boolean;
}

export type BinaryOp = '^' | '*' | '/' | '+' | '-' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';

export type FormulaAst =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'err'; readonly code: CellErrorCode }
  | { readonly t: 'ref'; readonly ref: ResolvedRef; readonly abs: AbsFlags }
  | { readonly t: 'name'; readonly name: string }
  | { readonly t: 'unary'; readonly op: '+' | '-'; readonly arg: FormulaAst }
  | { readonly t: 'percent'; readonly arg: FormulaAst }
  | { readonly t: 'binary'; readonly op: BinaryOp; readonly left: FormulaAst; readonly right: FormulaAst }
  | { readonly t: 'call'; readonly fn: string; readonly args: ReadonlyArray<FormulaAst> }
  | { readonly t: 'paren'; readonly arg: FormulaAst };

export interface ParseContext {
  readonly sheetNames: ReadonlyArray<string>;
  /** Key: uppercased name. */
  readonly names: ReadonlyMap<string, NamedParameter>;
}

export type ParseResult =
  | { readonly ok: true; readonly ast: FormulaAst }
  | { readonly ok: false; readonly offset: number; readonly message: string };
