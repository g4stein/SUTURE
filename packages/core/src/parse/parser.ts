import { normalizeRange, parseA1, splitSheetPrefix, type CellCoord } from '../model/address.ts';
import { errorCodeFromLiteral } from '../boundary/libraryErrors.ts';
import type { AbsFlags, BinaryOp, FormulaAst, ParseContext, ParseResult, ResolvedRef } from './ast.ts';

type Token =
  | { readonly k: 'num'; readonly v: number; readonly at: number }
  | { readonly k: 'str'; readonly v: string; readonly at: number }
  | { readonly k: 'err'; readonly v: string; readonly at: number }
  | { readonly k: 'ident'; readonly v: string; readonly at: number; readonly end: number } // may include sheet prefix + A1
  | { readonly k: 'op'; readonly v: string; readonly at: number }
  | { readonly k: 'eof'; readonly at: number };

class ParseError extends Error {
  readonly offset: number;
  constructor(offset: number, message: string) {
    super(message);
    this.offset = offset;
  }
}

const OPS2 = ['<>', '<=', '>='];
const ERROR_LITERALS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#CYCLE!', '#NUM!', '#SQL!', '#PY!', '#TIMEOUT!', '#NULL!', '#SPILL!']
  .sort((a, b) => b.length - a.length);
const OPS1 = '+-*/^&=<>(),:%';
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_.$]/;

function lex(src: string, base: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const at = base + i;
    if (ch === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= src.length) throw new ParseError(at, 'unterminated string literal');
        const c = src[j];
        if (c === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += c;
        j++;
      }
      out.push({ k: 'str', v, at });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m?.[0] ?? ch;
      const v = Number(text);
      if (!Number.isFinite(v)) throw new ParseError(at, `number out of range: ${text}`);
      out.push({ k: 'num', v, at });
      i += text.length;
      continue;
    }
    if (ch === '#') {
      // Match only known error literals (longest first). A greedy pattern would swallow "#N/A/FALSE".
      const rest = src.slice(i).toUpperCase();
      const text = ERROR_LITERALS.find((lit) => rest.startsWith(lit));
      if (text === undefined) throw new ParseError(at, 'unknown error literal');
      out.push({ k: 'err', v: text, at });
      i += text.length;
      continue;
    }
    if (ch === "'") {
      // quoted sheet prefix: 'My Sheet'!A1
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new ParseError(at, 'unterminated sheet name');
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (src[j + 1] !== '!') throw new ParseError(at, "expected '!' after quoted sheet name");
      let k = j + 2;
      while (k < src.length && IDENT_CHAR.test(src[k] ?? '')) k++;
      out.push({ k: 'ident', v: src.slice(i, k), at, end: base + k });
      i = k;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let k = i + 1;
      while (k < src.length && IDENT_CHAR.test(src[k] ?? '')) k++;
      if (src[k] === '!') {
        k++;
        while (k < src.length && IDENT_CHAR.test(src[k] ?? '')) k++;
      }
      out.push({ k: 'ident', v: src.slice(i, k), at, end: base + k });
      i = k;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ k: 'op', v: two, at });
      i += 2;
      continue;
    }
    if (OPS1.includes(ch)) {
      out.push({ k: 'op', v: ch, at });
      i++;
      continue;
    }
    throw new ParseError(at, `unexpected character '${ch}'`);
  }
  out.push({ k: 'eof', at: base + src.length });
  return out;
}

const BINARY_BP: Readonly<Record<string, number>> = {
  '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10,
  '&': 20,
  '+': 30, '-': 30,
  '*': 40, '/': 40,
  '^': 50,
};
const PERCENT_BP = 60;
const PREFIX_BP = 70;

interface RefParts {
  readonly sheet: string | null;
  readonly col: number;
  readonly row: number;
  readonly absCol: boolean;
  readonly absRow: boolean;
}

function asRefParts(text: string): RefParts | null {
  const split = splitSheetPrefix(text);
  if (split === null) return null;
  const a1 = parseA1(split.rest);
  if (a1 === null) return null;
  return { sheet: split.sheet, col: a1.col, row: a1.row, absCol: a1.absCol, absRow: a1.absRow };
}

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: ReadonlyArray<Token>,
    private readonly src: string,
    private readonly base: number,
    private readonly at: CellCoord,
    private readonly ctx: ParseContext,
  ) {}

  private peek(): Token {
    return this.toks[this.pos] ?? { k: 'eof', at: this.base + this.src.length };
  }
  private next(): Token {
    const t = this.peek();
    this.pos++;
    return t;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === v;
  }
  private expectOp(v: string): void {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) throw new ParseError(t.at, `expected '${v}'`);
  }

  parseAll(): FormulaAst {
    const e = this.expr(0);
    const t = this.peek();
    if (t.k !== 'eof') throw new ParseError(t.at, 'unexpected input after expression');
    return e;
  }

  private expr(minBp: number): FormulaAst {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'op') break;
      if (t.v === '%') {
        if (PERCENT_BP < minBp) break;
        this.next();
        left = { t: 'percent', arg: left };
        continue;
      }
      const bp = BINARY_BP[t.v];
      if (bp === undefined || bp <= minBp) break;
      this.next();
      const right = this.expr(bp); // left-associative at every level, including ^
      left = { t: 'binary', op: t.v as BinaryOp, left, right };
    }
    return left;
  }

  private prefix(): FormulaAst {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'num', v: t.v };
      case 'str':
        return { t: 'str', v: t.v };
      case 'err': {
        const code = errorCodeFromLiteral(t.v);
        if (code === null) throw new ParseError(t.at, `unknown error literal ${t.v}`);
        return { t: 'err', code };
      }
      case 'op':
        if (t.v === '(') {
          const inner = this.expr(0);
          this.expectOp(')');
          return { t: 'paren', arg: inner };
        }
        if (t.v === '-' || t.v === '+') {
          return { t: 'unary', op: t.v, arg: this.expr(PREFIX_BP) };
        }
        throw new ParseError(t.at, `unexpected '${t.v}'`);
      case 'ident':
        return this.identifier(t);
      case 'eof':
        throw new ParseError(t.at, 'unexpected end of formula');
    }
  }

  private identifier(t: Extract<Token, { k: 'ident' }>): FormulaAst {
    if (this.isOp('(') && !t.v.includes('!')) {
      this.next();
      const args: FormulaAst[] = [];
      if (!this.isOp(')')) {
        for (;;) {
          args.push(this.expr(0));
          if (this.isOp(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expectOp(')');
      return { t: 'call', fn: t.v.toUpperCase(), args };
    }
    const parts = asRefParts(t.v);
    if (parts !== null) {
      if (this.isOp(':')) {
        this.next();
        const t2 = this.next();
        const p2 = t2.k === 'ident' && !t2.v.includes('!') ? asRefParts(t2.v) : null;
        if (t2.k !== 'ident' || p2 === null) throw new ParseError(t2.at, 'expected a cell reference after ":"');
        const text = this.src.slice(t.at - this.base, t2.end - this.base);
        return { t: 'ref', ref: this.resolveRange(parts, p2, text), abs: { col: parts.absCol, row: parts.absRow, col2: p2.absCol, row2: p2.absRow } };
      }
      return { t: 'ref', ref: this.resolveCell(parts, t.v), abs: { col: parts.absCol, row: parts.absRow, col2: false, row2: false } };
    }
    if (t.v.includes('!')) throw new ParseError(t.at, `invalid reference ${t.v}`);
    const up = t.v.toUpperCase();
    if (up === 'TRUE') return { t: 'bool', v: true };
    if (up === 'FALSE') return { t: 'bool', v: false };
    const named = this.ctx.names.get(up);
    if (named === undefined) return { t: 'name', name: t.v };
    const abs: AbsFlags = { col: true, row: true, col2: true, row2: true };
    if (named.target.kind === 'cell') return { t: 'ref', ref: { kind: 'cell', coord: named.target.coord, text: t.v }, abs };
    return { t: 'ref', ref: { kind: 'range', range: named.target.range, text: t.v }, abs };
  }

  private sheetOf(p: RefParts): string | null {
    if (p.sheet === null) return this.at.sheet;
    const up = p.sheet.toUpperCase();
    return this.ctx.sheetNames.find((s) => s.toUpperCase() === up) ?? null;
  }

  private resolveCell(p: RefParts, text: string): ResolvedRef {
    const sheet = this.sheetOf(p);
    if (sheet === null) return { kind: 'unresolved', text, code: '#REF!' };
    return { kind: 'cell', coord: { sheet, row: p.row, col: p.col }, text };
  }

  private resolveRange(a: RefParts, b: RefParts, text: string): ResolvedRef {
    const sheet = this.sheetOf(a);
    if (sheet === null) return { kind: 'unresolved', text, code: '#REF!' };
    return { kind: 'range', range: normalizeRange(sheet, a, b), text };
  }
}

/** Parses formula text without the leading "=". `base` is the offset of `src` within the cell source. */
export function parseFormula(src: string, at: CellCoord, ctx: ParseContext, base = 0): ParseResult {
  try {
    const toks = lex(src, base);
    const ast = new Parser(toks, src, base, at, ctx).parseAll();
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, offset: e.offset, message: e.message };
    throw e;
  }
}

/** Resolves a standalone reference string (used by SQL {{…}} and Python inputs['…']). */
export function resolveRefText(text: string, at: CellCoord, ctx: ParseContext): ResolvedRef {
  const r = parseFormula(text.trim(), at, ctx);
  if (r.ok) {
    if (r.ast.t === 'ref') return r.ast.ref;
    if (r.ast.t === 'name') return { kind: 'unresolved', text, code: '#NAME?' };
  }
  return { kind: 'unresolved', text, code: '#REF!' };
}
