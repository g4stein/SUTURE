import type { CellCoord } from '../model/address.ts';
import { makeError, type CellError, type ScalarValue } from '../model/values.ts';
import { errorCodeFromLiteral } from '../boundary/libraryErrors.ts';
import type { FormulaAst, ParseContext, ResolvedRef } from './ast.ts';
import { parseFormula, resolveRefText } from './parser.ts';
import { toCellKey } from '../model/address.ts';

export interface SqlSlot {
  readonly placeholder: string;
  readonly ref: ResolvedRef;
}

export interface SqlTemplate {
  readonly text: string;
  readonly slots: ReadonlyArray<SqlSlot>;
  /** Set when the template is malformed (Req 3.8); the cell evaluates to #SQL! without dispatch. */
  readonly error?: string;
}

export interface PyProgram {
  readonly code: string;
  readonly vectorized: boolean;
  readonly inputKeys: ReadonlyArray<{ readonly key: string; readonly ref: ResolvedRef }>;
}

export type ParsedCell =
  | { readonly dialect: 'literal'; readonly value: ScalarValue | CellError }
  | { readonly dialect: 'formula'; readonly ast: FormulaAst; readonly refs: ReadonlyArray<ResolvedRef> }
  | { readonly dialect: 'sql'; readonly template: SqlTemplate; readonly refs: ReadonlyArray<ResolvedRef> }
  | { readonly dialect: 'py'; readonly program: PyProgram; readonly refs: ReadonlyArray<ResolvedRef> }
  | { readonly dialect: 'formula'; readonly parseError: { readonly offset: number; readonly message: string } };

const NUMBER_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseLiteral(raw: string, at: CellCoord): ScalarValue | CellError {
  if (raw === '') return null;
  const up = raw.toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  if (raw.startsWith('#')) {
    const code = errorCodeFromLiteral(raw);
    if (code !== null) return makeError(code, `error literal ${raw}`, toCellKey(at), 'formula');
  }
  if (NUMBER_LITERAL.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export function collectRefs(ast: FormulaAst, out: ResolvedRef[] = []): ResolvedRef[] {
  switch (ast.t) {
    case 'ref':
      out.push(ast.ref);
      break;
    case 'unary':
    case 'percent':
    case 'paren':
      collectRefs(ast.arg, out);
      break;
    case 'binary':
      collectRefs(ast.left, out);
      collectRefs(ast.right, out);
      break;
    case 'call':
      for (const a of ast.args) collectRefs(a, out);
      break;
    default:
      break;
  }
  return out;
}

function containsEngineCall(ast: FormulaAst): boolean {
  switch (ast.t) {
    case 'call':
      return ast.fn === 'SQL' || ast.fn === 'PY' || ast.args.some(containsEngineCall);
    case 'unary':
    case 'percent':
    case 'paren':
      return containsEngineCall(ast.arg);
    case 'binary':
      return containsEngineCall(ast.left) || containsEngineCall(ast.right);
    default:
      return false;
  }
}

const INTERPOLATION = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function parseSqlTemplate(sql: string, at: CellCoord, ctx: ParseContext): SqlTemplate | { readonly error: string } {
  const slots: SqlSlot[] = [];
  const byText = new Map<string, string>();
  let bad: string | null = null;
  const text = sql.replace(INTERPOLATION, (_m, body: string) => {
    const refText = body.trim();
    if (refText === '') {
      bad = 'empty {{}} interpolation';
      return '';
    }
    const existing = byText.get(refText.toUpperCase());
    if (existing !== undefined) return existing;
    const placeholder = `__suture_s${slots.length}`;
    byText.set(refText.toUpperCase(), placeholder);
    slots.push({ placeholder, ref: resolveRefText(refText, at, ctx) });
    return placeholder;
  });
  if (bad !== null) return { error: bad };
  if (text.includes('{{') || text.includes('}}')) return { error: 'unterminated {{ interpolation' };
  return { text, slots };
}

const INPUT_KEY = /inputs\[\s*(['"])((?:(?!\1).)+)\1\s*\]/g;

export function parsePyProgram(code: string, vectorized: boolean, at: CellCoord, ctx: ParseContext): PyProgram {
  const seen = new Set<string>();
  const inputKeys: Array<{ key: string; ref: ResolvedRef }> = [];
  for (const m of code.matchAll(INPUT_KEY)) {
    const key = m[2] ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    inputKeys.push({ key, ref: resolveRefText(key, at, ctx) });
  }
  return { code, vectorized, inputKeys };
}

export function parseCell(raw: string, at: CellCoord, ctx: ParseContext): ParsedCell {
  if (!raw.startsWith('=')) return { dialect: 'literal', value: parseLiteral(raw, at) };
  const r = parseFormula(raw.slice(1), at, ctx, 1);
  if (!r.ok) return { dialect: 'formula', parseError: { offset: r.offset, message: r.message } };
  const ast = r.ast;
  if (ast.t === 'call' && (ast.fn === 'SQL' || ast.fn === 'PY')) {
    const nested = ast.args.some(containsEngineCall);
    const first = ast.args[0];
    if (nested || first === undefined || first.t !== 'str') {
      return { dialect: 'formula', parseError: { offset: 1, message: `${ast.fn}() takes a string literal as its first argument and must be the whole cell` } };
    }
    if (ast.fn === 'SQL') {
      if (ast.args.length !== 1) return { dialect: 'formula', parseError: { offset: 1, message: 'SQL() takes exactly one argument' } };
      const tpl = parseSqlTemplate(first.v, at, ctx);
      if ('error' in tpl && !('text' in tpl)) return { dialect: 'sql', template: { text: '', slots: [], error: tpl.error }, refs: [] };
      return { dialect: 'sql', template: tpl, refs: tpl.slots.map((s) => s.ref) };
    }
    const second = ast.args[1];
    if (ast.args.length > 2 || (second !== undefined && second.t !== 'bool')) {
      return { dialect: 'formula', parseError: { offset: 1, message: 'PY(code, [vectorized]) takes a string and an optional TRUE/FALSE literal' } };
    }
    const program = parsePyProgram(first.v, second?.t === 'bool' ? second.v : false, at, ctx);
    return { dialect: 'py', program, refs: program.inputKeys.map((k) => k.ref) };
  }
  if (containsEngineCall(ast)) {
    return { dialect: 'formula', parseError: { offset: 1, message: 'engine calls (SQL/PY) must be the whole cell' } };
  }
  return { dialect: 'formula', ast, refs: collectRefs(ast) };
}
