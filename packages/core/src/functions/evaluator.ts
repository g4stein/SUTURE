import * as formulajs from '@formulajs/formulajs';
import type { CellCoord, CellKey } from '../model/address.ts';
import { toCellKey } from '../model/address.ts';
import { isCellError, makeError, type CellError, type CellErrorCode, type CellValue } from '../model/values.ts';
import { mapLibraryError } from '../boundary/libraryErrors.ts';
import { normalizeNumber } from '../boundary/normalize.ts';
import { ipow } from '../util/hash.ts';
import type { FormulaAst, ResolvedRef } from '../parse/ast.ts';
import { compileCriterion, type Criterion } from './criteria.ts';

export type EvalArg =
  | { readonly kind: 'scalar'; readonly value: CellValue }
  | { readonly kind: 'range'; readonly rows: number; readonly cols: number; readonly values: ReadonlyArray<CellValue> };

export type EvaluatedLeaf =
  | { readonly kind: 'ref'; readonly ref: ResolvedRef }
  | { readonly kind: 'errorLiteral'; readonly code: CellErrorCode };

export interface EvalEnv {
  readonly at: CellCoord;
  readonly valueOf: (ref: ResolvedRef) => EvalArg;
  readonly onLeaf?: (leaf: EvaluatedLeaf) => void;
  readonly onKernelException?: (fn: string, message: string) => void;
}

export type SupportedFunction =
  | 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'COUNT' | 'COUNTA' | 'ROUND' | 'ABS' | 'POWER' | 'SQRT' | 'MOD'
  | 'SUMIF' | 'SUMIFS' | 'COUNTIF' | 'COUNTIFS' | 'AVERAGEIF'
  | 'IF' | 'AND' | 'OR' | 'NOT' | 'IFERROR' | 'ISERROR' | 'ISBLANK' | 'ISNUMBER'
  | 'VLOOKUP' | 'INDEX' | 'MATCH' | 'NPV' | 'PMT' | 'IRR';

export interface FunctionSpec {
  readonly name: SupportedFunction;
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly interceptsErrors: boolean;
  /** Spec 01 §6.4; 'native' where the steering requires it or a formulajs conformance row failed (Phase 3 probe). */
  readonly kernel: 'formulajs' | 'native';
}

const spec = (name: SupportedFunction, minArgs: number, maxArgs: number, kernel: 'formulajs' | 'native', interceptsErrors = false): [SupportedFunction, FunctionSpec] =>
  [name, { name, minArgs, maxArgs, kernel, interceptsErrors }];

/** The allowlist: exactly the 30 functions of Spec 01 Req 6.1. Every other name is #NAME?. */
export const FUNCTIONS: ReadonlyMap<SupportedFunction, FunctionSpec> = new Map<SupportedFunction, FunctionSpec>([
  spec('SUM', 1, 255, 'formulajs'), spec('AVERAGE', 1, 255, 'formulajs'), spec('MIN', 1, 255, 'formulajs'), spec('MAX', 1, 255, 'formulajs'),
  spec('COUNT', 1, 255, 'formulajs'), spec('COUNTA', 1, 255, 'native'), spec('ROUND', 2, 2, 'native'), spec('ABS', 1, 1, 'formulajs'),
  spec('POWER', 2, 2, 'native'), spec('SQRT', 1, 1, 'formulajs'), spec('MOD', 2, 2, 'native'),
  spec('SUMIF', 2, 3, 'native'), spec('SUMIFS', 3, 255, 'native'), spec('COUNTIF', 2, 2, 'native'), spec('COUNTIFS', 2, 254, 'native'), spec('AVERAGEIF', 2, 3, 'native'),
  spec('IF', 2, 3, 'native'), spec('AND', 1, 255, 'native'), spec('OR', 1, 255, 'native'), spec('NOT', 1, 1, 'native'),
  spec('IFERROR', 2, 2, 'native', true), spec('ISERROR', 1, 1, 'native', true), spec('ISBLANK', 1, 1, 'native'), spec('ISNUMBER', 1, 1, 'native'),
  spec('VLOOKUP', 3, 4, 'native'), spec('INDEX', 2, 3, 'native'), spec('MATCH', 2, 3, 'formulajs'),
  spec('NPV', 2, 255, 'native'), spec('PMT', 3, 5, 'native'), spec('IRR', 1, 2, 'native'),
]);

export function lookupFunction(upperName: string): FunctionSpec | null {
  return FUNCTIONS.get(upperName as SupportedFunction) ?? null;
}

const NUMBER_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function origin(env: EvalEnv): CellKey {
  return toCellKey(env.at);
}

function err(env: EvalEnv, code: CellErrorCode, message: string): CellError {
  return makeError(code, message, origin(env), 'formula');
}

export function firstError(args: ReadonlyArray<EvalArg>): CellError | null {
  for (const a of args) {
    if (a.kind === 'scalar') {
      if (isCellError(a.value)) return a.value;
    } else {
      for (const v of a.values) if (isCellError(v)) return v;
    }
  }
  return null;
}

function toNumber(v: CellValue, env: EvalEnv): number | CellError {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (typeof v === 'string') {
    if (NUMBER_LITERAL.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return err(env, '#VALUE!', `cannot convert "${v}" to a number`);
  }
  if (v.kind === 'error') return v;
  return err(env, '#VALUE!', `a ${v.kind} cannot be used as a number`);
}

function toLogical(v: CellValue, env: EvalEnv): boolean | CellError {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (typeof v === 'string') {
    const up = v.toUpperCase();
    if (up === 'TRUE') return true;
    if (up === 'FALSE') return false;
    return err(env, '#VALUE!', `cannot convert "${v}" to TRUE/FALSE`);
  }
  if (v.kind === 'error') return v;
  return err(env, '#VALUE!', `a ${v.kind} cannot be used as TRUE/FALSE`);
}

function toText(v: CellValue, env: EvalEnv): string | CellError {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === null) return '';
  if (v.kind === 'error') return v;
  return err(env, '#VALUE!', `a ${v.kind} cannot be used as text`);
}

function finish(x: number, env: EvalEnv, evidence: 'none' | 'divisionByZero' = 'none'): number | CellError {
  return normalizeNumber(x, evidence, origin(env), 'formula');
}

function scalarOf(a: EvalArg, env: EvalEnv): CellValue {
  return a.kind === 'range' ? err(env, '#VALUE!', 'a range cannot be used where a single value is required') : a.value;
}

/** Evaluates to a scalar; a range in scalar position is #VALUE!. */
function scalar(ast: FormulaAst, env: EvalEnv): CellValue {
  return scalarOf(evalNode(ast, env), env);
}

function typeRank(v: number | string | boolean): number {
  return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
}

/** Spreadsheet-compatible ordering: number < string < boolean; strings case-insensitive (locale-free lowercasing). */
export function compareValues(a: CellValue, b: CellValue, env: EvalEnv): number | CellError {
  if (isCellError(a)) return a;
  if (isCellError(b)) return b;
  if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) {
    return err(env, '#VALUE!', 'tables and matrices cannot be compared');
  }
  let x = a;
  let y = b;
  if (x === null && y === null) return 0;
  if (x === null) x = typeof y === 'number' ? 0 : typeof y === 'string' ? '' : false;
  if (y === null) y = typeof x === 'number' ? 0 : typeof x === 'string' ? '' : false;
  const rx = typeRank(x);
  const ry = typeRank(y);
  if (rx !== ry) return rx - ry;
  if (typeof x === 'string' && typeof y === 'string') {
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    return lx < ly ? -1 : lx > ly ? 1 : 0;
  }
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  const nx = x as number;
  const ny = y as number;
  return nx < ny ? -1 : nx > ny ? 1 : 0;
}

function power(base: number, exp: number, env: EvalEnv): number | CellError {
  if (base === 0 && exp === 0) return err(env, '#NUM!', '0^0 is undefined');
  if (base === 0 && exp < 0) return makeError('#DIV/0!', 'zero raised to a negative power', origin(env), 'formula');
  if (Number.isInteger(exp)) return finish(ipow(base, exp), env);
  if (base < 0) return err(env, '#NUM!', 'negative base with a non-integer exponent');
  return finish(Math.pow(base, exp), env);
}

function binary(ast: Extract<FormulaAst, { t: 'binary' }>, env: EvalEnv): CellValue {
  const l = scalar(ast.left, env);
  const r = scalar(ast.right, env);
  if (isCellError(l)) return l;
  if (isCellError(r)) return r;
  switch (ast.op) {
    case '&': {
      const a = toText(l, env);
      if (isCellError(a)) return a;
      const b = toText(r, env);
      if (isCellError(b)) return b;
      return a + b;
    }
    case '=': case '<>': case '<': case '>': case '<=': case '>=': {
      const c = compareValues(l, r, env);
      if (isCellError(c)) return c;
      switch (ast.op) {
        case '=': return c === 0;
        case '<>': return c !== 0;
        case '<': return c < 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        default: return c >= 0;
      }
    }
    default: {
      const a = toNumber(l, env);
      if (isCellError(a)) return a;
      const b = toNumber(r, env);
      if (isCellError(b)) return b;
      switch (ast.op) {
        case '+': return finish(a + b, env);
        case '-': return finish(a - b, env);
        case '*': return finish(a * b, env);
        case '/':
          if (b === 0) return makeError('#DIV/0!', 'division by zero', origin(env), 'formula');
          return finish(a / b, env);
        default:
          return power(a, b, env);
      }
    }
  }
}

function evalNode(ast: FormulaAst, env: EvalEnv): EvalArg {
  switch (ast.t) {
    case 'num': return { kind: 'scalar', value: ast.v };
    case 'str': return { kind: 'scalar', value: ast.v };
    case 'bool': return { kind: 'scalar', value: ast.v };
    case 'err':
      env.onLeaf?.({ kind: 'errorLiteral', code: ast.code });
      return { kind: 'scalar', value: err(env, ast.code, `error literal ${ast.code}`) };
    case 'ref':
      env.onLeaf?.({ kind: 'ref', ref: ast.ref });
      if (ast.ref.kind === 'unresolved') return { kind: 'scalar', value: err(env, ast.ref.code, `cannot resolve ${ast.ref.text}`) };
      return env.valueOf(ast.ref);
    case 'name':
      return { kind: 'scalar', value: err(env, '#NAME?', `unknown name ${ast.name}`) };
    case 'paren':
      return evalNode(ast.arg, env);
    case 'unary': {
      const n = toNumber(scalar(ast.arg, env), env);
      if (isCellError(n)) return { kind: 'scalar', value: n };
      return { kind: 'scalar', value: ast.op === '-' ? finish(-n, env) : n };
    }
    case 'percent': {
      const n = toNumber(scalar(ast.arg, env), env);
      if (isCellError(n)) return { kind: 'scalar', value: n };
      return { kind: 'scalar', value: finish(n / 100, env) };
    }
    case 'binary':
      return { kind: 'scalar', value: binary(ast, env) };
    case 'call':
      return { kind: 'scalar', value: call(ast, env) };
  }
}

// ------------------------------------------------------------------ argument views

interface Arg {
  readonly node: FormulaAst;
  readonly v: EvalArg;
}

function isRefNode(n: FormulaAst): boolean {
  return n.t === 'ref' || (n.t === 'paren' && isRefNode(n.arg));
}

/** A 2-D view over a range, a Matrix2D, or a single value (1×1). */
interface Grid {
  readonly rows: number;
  readonly cols: number;
  readonly at: (r: number, c: number) => CellValue;
  readonly values: ReadonlyArray<CellValue>;
}

function gridOf(a: EvalArg): Grid | null {
  if (a.kind === 'range') return { rows: a.rows, cols: a.cols, values: a.values, at: (r, c) => a.values[r * a.cols + c] ?? null };
  const v = a.value;
  if (v !== null && typeof v === 'object' && v.kind === 'matrix') {
    const values = [...v.data];
    return { rows: v.rows, cols: v.cols, values, at: (r, c) => values[r * v.cols + c] ?? null };
  }
  if (v !== null && typeof v === 'object' && v.kind === 'table') return null;
  return { rows: 1, cols: 1, values: [v], at: () => v };
}

/** Numeric members per Spec 01 §6.3 (SUM, AVERAGE, MIN, MAX, COUNT, NPV, IRR). `lenient`: COUNT ignores non-numeric direct values. */
function numericList(args: ReadonlyArray<Arg>, env: EvalEnv, lenient = false): number[] | CellError {
  const out: number[] = [];
  for (const { node, v } of args) {
    if (v.kind === 'range' || isRefNode(node)) {
      const g = gridOf(v);
      if (g === null) return err(env, '#VALUE!', 'a table cannot be aggregated directly');
      for (const m of g.values) {
        if (typeof m === 'number') out.push(m);
        else if (m !== null && typeof m === 'object' && m.kind === 'table') return err(env, '#VALUE!', 'a table cannot be aggregated directly');
      }
      continue;
    }
    const x = v.value;
    if (x !== null && typeof x === 'object' && x.kind === 'matrix') {
      for (const e of x.data) out.push(e);
      continue;
    }
    const n = toNumber(x, env);
    if (isCellError(n)) {
      if (lenient && !(x !== null && typeof x === 'object')) continue;
      return n;
    }
    out.push(n);
  }
  return out;
}

/** Logical members (AND / OR): ranges keep numbers and booleans; direct values are coerced. */
function logicalList(args: ReadonlyArray<Arg>, env: EvalEnv): boolean[] | CellError {
  const out: boolean[] = [];
  for (const { node, v } of args) {
    if (v.kind === 'range' || isRefNode(node)) {
      const g = gridOf(v);
      if (g === null) return err(env, '#VALUE!', 'a table cannot be used as TRUE/FALSE');
      for (const m of g.values) {
        if (typeof m === 'boolean') out.push(m);
        else if (typeof m === 'number') out.push(m !== 0);
        else if (m !== null && typeof m === 'object' && m.kind === 'table') return err(env, '#VALUE!', 'a table cannot be used as TRUE/FALSE');
      }
      continue;
    }
    const b = toLogical(v.value, env);
    if (isCellError(b)) return b;
    out.push(b);
  }
  return out;
}

function fromLibrary(result: unknown, env: EvalEnv): CellValue {
  if (result instanceof Error) return mapLibraryError(result.message, origin(env));
  if (typeof result === 'number') return finish(result, env);
  throw new Error(`unexpected formulajs result ${typeof result}`);
}

// ------------------------------------------------------------------ dispatch

function call(ast: Extract<FormulaAst, { t: 'call' }>, env: EvalEnv): CellValue {
  const fs = lookupFunction(ast.fn);
  if (fs === null) return err(env, '#NAME?', `unknown or unsupported function ${ast.fn}()`);
  if (ast.args.length < fs.minArgs || ast.args.length > fs.maxArgs) {
    return err(env, '#VALUE!', `${ast.fn}() takes ${fs.minArgs === fs.maxArgs ? fs.minArgs : `${fs.minArgs}–${fs.maxArgs}`} arguments`);
  }
  if (fs.name === 'IF') return ifFn(ast.args, env);
  // Every other function evaluates all of its arguments eagerly, left to right.
  const args: Arg[] = ast.args.map((node) => ({ node, v: evalNode(node, env) }));
  try {
    if (fs.name === 'IFERROR') {
      const [v, fb] = args;
      if (v === undefined || fb === undefined || v.v.kind === 'range' || fb.v.kind === 'range') return err(env, '#VALUE!', 'IFERROR() takes single values');
      return isCellError(v.v.value) ? fb.v.value : v.v.value;
    }
    if (fs.name === 'ISERROR') {
      const [v] = args;
      if (v === undefined || v.v.kind === 'range') return err(env, '#VALUE!', 'ISERROR() takes a single value');
      return isCellError(v.v.value);
    }
    const e = firstError(args.map((a) => a.v));
    if (e !== null) return e;
    return kernel(fs.name, args, env);
  } catch (ex) {
    const message = ex instanceof Error ? ex.message : String(ex);
    env.onKernelException?.(fs.name, message);
    return err(env, '#VALUE!', `internal: ${fs.name}`);
  }
}

function ifFn(args: ReadonlyArray<FormulaAst>, env: EvalEnv): CellValue {
  const [condAst, thenAst, elseAst] = args;
  if (condAst === undefined || thenAst === undefined) return err(env, '#VALUE!', 'IF() needs a condition and a value');
  const cond = scalar(condAst, env);
  if (isCellError(cond)) return cond;
  const truth = toLogical(cond, env);
  if (isCellError(truth)) return truth;
  // Short-circuit: only the taken branch is evaluated (steering dag-and-type-contract §5).
  if (truth) return scalar(thenAst, env);
  return elseAst === undefined ? false : scalar(elseAst, env);
}

function num(a: Arg | undefined, env: EvalEnv, fallback?: number): number | CellError {
  if (a === undefined) return fallback ?? err(env, '#VALUE!', 'missing argument');
  return toNumber(scalarOf(a.v, env), env);
}

function kernel(name: SupportedFunction, args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  switch (name) {
    case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': case 'COUNT': {
      const nums = numericList(args, env, name === 'COUNT');
      if (!Array.isArray(nums)) return nums;
      if (name === 'COUNT') return nums.length;
      if (name === 'AVERAGE' && nums.length === 0) return makeError('#DIV/0!', 'AVERAGE() of no numbers', origin(env), 'formula');
      if ((name === 'MAX' || name === 'MIN') && nums.length === 0) return 0;
      const k = name === 'SUM' ? formulajs.SUM : name === 'AVERAGE' ? formulajs.AVERAGE : name === 'MIN' ? formulajs.MIN : formulajs.MAX;
      return fromLibrary(k(nums), env);
    }
    case 'COUNTA': {
      let n = 0;
      for (const { v } of args) {
        const g = gridOf(v);
        if (g === null) n++;
        else for (const m of g.values) if (m !== null) n++;
      }
      return n;
    }
    case 'ROUND': {
      const x = num(args[0], env);
      if (isCellError(x)) return x;
      const d = num(args[1], env);
      if (isCellError(d)) return d;
      const digits = Math.trunc(d);
      if (digits < -308 || digits > 308) return err(env, '#NUM!', 'ROUND() digits out of range');
      return finish(roundDecimal(x, digits), env);
    }
    case 'ABS': case 'SQRT': {
      const x = num(args[0], env);
      if (isCellError(x)) return x;
      return fromLibrary(name === 'ABS' ? formulajs.ABS(x) : formulajs.SQRT(x), env);
    }
    case 'POWER': {
      const b = num(args[0], env);
      if (isCellError(b)) return b;
      const p = num(args[1], env);
      if (isCellError(p)) return p;
      return power(b, p, env);
    }
    case 'MOD': {
      const n = num(args[0], env);
      if (isCellError(n)) return n;
      const d = num(args[1], env);
      if (isCellError(d)) return d;
      if (d === 0) return makeError('#DIV/0!', 'MOD() by zero', origin(env), 'formula');
      // Native: formulajs MOD returns -2 for MOD(5, -3); the result must take the divisor's sign (-1).
      let r = n % d;
      if (r !== 0 && (r < 0) !== (d < 0)) r += d;
      return finish(r === 0 ? 0 : r, env);
    }
    case 'SUMIF': case 'AVERAGEIF': case 'COUNTIF':
      return conditional(name, args, env);
    case 'SUMIFS': case 'COUNTIFS':
      return conditionalMulti(name, args, env);
    case 'AND': case 'OR': {
      const ls = logicalList(args, env);
      if (!Array.isArray(ls)) return ls;
      if (ls.length === 0) return err(env, '#VALUE!', `${name}() found no TRUE/FALSE values`);
      return name === 'AND' ? ls.every(Boolean) : ls.some(Boolean);
    }
    case 'NOT': {
      const b = toLogical(scalarOf((args[0] as Arg).v, env), env);
      return isCellError(b) ? b : !b;
    }
    case 'ISBLANK': case 'ISNUMBER': {
      const a = args[0] as Arg;
      if (a.v.kind === 'range') return err(env, '#VALUE!', `${name}() takes a single value`);
      return name === 'ISBLANK' ? a.v.value === null : typeof a.v.value === 'number';
    }
    case 'VLOOKUP': return vlookup(args, env);
    case 'INDEX': return index(args, env);
    case 'MATCH': return match(args, env);
    case 'NPV': return npv(args, env);
    case 'PMT': return pmt(args, env);
    case 'IRR': return irr(args, env);
    case 'IF': case 'IFERROR': case 'ISERROR':
      throw new Error(`${name} is dispatched before kernels`);
  }
}

// ------------------------------------------------------------------ conditional aggregation (native: formulajs fails §6.4)

function criterionOf(a: Arg | undefined, env: EvalEnv): Criterion | CellError {
  if (a === undefined) return err(env, '#VALUE!', 'missing criteria');
  return compileCriterion(scalarOf(a.v, env), (m) => err(env, '#VALUE!', m));
}

function sameShape(a: Grid, b: Grid): boolean {
  return a.rows === b.rows && a.cols === b.cols;
}

function conditional(name: 'SUMIF' | 'AVERAGEIF' | 'COUNTIF', args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const range = gridOf((args[0] as Arg).v);
  if (range === null) return err(env, '#VALUE!', `${name}() needs a range`);
  const crit = criterionOf(args[1], env);
  if (typeof crit !== 'function') return crit;
  const target = args[2] === undefined ? range : gridOf(args[2].v);
  if (target === null || !sameShape(range, target)) return err(env, '#VALUE!', `${name}() ranges must have the same shape`);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < range.values.length; i++) {
    if (!crit(range.values[i] ?? null)) continue;
    if (name === 'COUNTIF') { count++; continue; }
    const t = target.values[i];
    if (typeof t === 'number') { sum += t; count++; }
  }
  if (name === 'COUNTIF') return count;
  if (name === 'AVERAGEIF') return count === 0 ? makeError('#DIV/0!', 'AVERAGEIF() matched no numbers', origin(env), 'formula') : finish(sum / count, env);
  return finish(sum, env);
}

function conditionalMulti(name: 'SUMIFS' | 'COUNTIFS', args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const start = name === 'SUMIFS' ? 1 : 0;
  if ((args.length - start) % 2 !== 0) return err(env, '#VALUE!', `${name}() takes range/criteria pairs`);
  const sumGrid = name === 'SUMIFS' ? gridOf((args[0] as Arg).v) : null;
  if (name === 'SUMIFS' && sumGrid === null) return err(env, '#VALUE!', 'SUMIFS() needs a sum range');
  const pairs: Array<{ g: Grid; c: Criterion }> = [];
  for (let i = start; i < args.length; i += 2) {
    const g = gridOf((args[i] as Arg).v);
    if (g === null) return err(env, '#VALUE!', `${name}() needs ranges`);
    const c = criterionOf(args[i + 1], env);
    if (typeof c !== 'function') return c;
    pairs.push({ g, c });
  }
  const shape = sumGrid ?? pairs[0]?.g;
  if (shape === undefined || pairs.some((p) => !sameShape(p.g, shape))) return err(env, '#VALUE!', `${name}() ranges must have the same shape`);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < shape.values.length; i++) {
    if (!pairs.every((p) => p.c(p.g.values[i] ?? null))) continue;
    count++;
    const t = sumGrid?.values[i];
    if (typeof t === 'number') sum += t;
  }
  return name === 'COUNTIFS' ? count : finish(sum, env);
}

// ------------------------------------------------------------------ lookup

function vlookup(args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const key = scalarOf((args[0] as Arg).v, env);
  if (isCellError(key)) return key;
  if (key !== null && typeof key === 'object') return err(env, '#VALUE!', 'VLOOKUP() key must be a single value');
  const table = gridOf((args[1] as Arg).v);
  if (table === null) return err(env, '#VALUE!', 'VLOOKUP() needs a range');
  const colRaw = num(args[2], env);
  if (isCellError(colRaw)) return colRaw;
  const col = Math.trunc(colRaw);
  if (col < 1) return err(env, '#VALUE!', 'VLOOKUP() column index must be at least 1');
  if (col > table.cols) return err(env, '#REF!', `VLOOKUP() column ${col} is outside a ${table.cols}-column table`);
  const approxArg = args[3] === undefined ? true : toLogical(scalarOf(args[3].v, env), env);
  if (isCellError(approxArg)) return approxArg;
  let hit = -1;
  if (!approxArg) {
    const exact = compileCriterion(typeof key === 'string' ? `=${key}` : key, (m) => err(env, '#VALUE!', m));
    if (typeof exact !== 'function') return exact;
    for (let r = 0; r < table.rows; r++) if (exact(table.at(r, 0))) { hit = r; break; }
  } else {
    // Ascending-sorted first column assumed: last row whose key is <= the lookup key (same type), stop at the first larger one.
    for (let r = 0; r < table.rows; r++) {
      const k = table.at(r, 0);
      if (k === null || typeof k === 'object' || typeof k !== typeof key) continue;
      const c = compareValues(k, key, env);
      if (isCellError(c)) return c;
      if (c <= 0) hit = r;
      else break;
    }
  }
  if (hit < 0) return err(env, '#N/A', `VLOOKUP() found no match for ${String(key)}`);
  return table.at(hit, col - 1);
}

function index(args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const g = gridOf((args[0] as Arg).v);
  if (g === null) return err(env, '#VALUE!', 'INDEX() needs a range or matrix');
  const r0 = num(args[1], env);
  if (isCellError(r0)) return r0;
  const c0 = args[2] === undefined ? null : num(args[2], env);
  if (c0 !== null && isCellError(c0)) return c0;
  let row = Math.trunc(r0);
  let col = c0 === null ? 1 : Math.trunc(c0);
  if (c0 === null && g.rows === 1 && g.cols > 1) { col = row; row = 1; } // a single-row range is indexed by column
  if (row < 1 || col < 1 || row > g.rows || col > g.cols) return err(env, '#REF!', `INDEX(${row}, ${col}) is outside a ${g.rows}×${g.cols} range`);
  return g.at(row - 1, col - 1);
}

function match(args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const key = scalarOf((args[0] as Arg).v, env);
  if (isCellError(key)) return key;
  if (key !== null && typeof key === 'object') return err(env, '#VALUE!', 'MATCH() key must be a single value');
  const g = gridOf((args[1] as Arg).v);
  if (g === null || (g.rows !== 1 && g.cols !== 1)) return err(env, '#N/A', 'MATCH() needs a single row or column');
  const t = args[2] === undefined ? 1 : num(args[2], env);
  if (isCellError(t)) return t;
  const type = t > 0 ? 1 : t < 0 ? -1 : 0;
  const flat = g.values.map((v) => (v !== null && typeof v === 'object' ? null : v));
  return fromLibrary(formulajs.MATCH(key, flat, type), env);
}

// ------------------------------------------------------------------ financial (native: binary exponentiation, Spec 01 §9)

function npv(args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const rate = num(args[0], env);
  if (isCellError(rate)) return rate;
  if (rate === -1) return makeError('#DIV/0!', 'NPV() with rate -1', origin(env), 'formula');
  const vals = numericList(args.slice(1), env);
  if (!Array.isArray(vals)) return vals;
  let s = 0;
  for (let i = 0; i < vals.length; i++) s += (vals[i] ?? 0) / ipow(1 + rate, i + 1);
  return finish(s, env);
}

function growth(rate: number, n: number): number {
  return Number.isInteger(n) ? ipow(1 + rate, n) : Math.pow(1 + rate, n);
}

function pmt(args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const rate = num(args[0], env);
  if (isCellError(rate)) return rate;
  const nper = num(args[1], env);
  if (isCellError(nper)) return nper;
  const pv = num(args[2], env);
  if (isCellError(pv)) return pv;
  const fv = num(args[3], env, 0);
  if (isCellError(fv)) return fv;
  const ty = num(args[4], env, 0);
  if (isCellError(ty)) return ty;
  if (nper === 0) return err(env, '#NUM!', 'PMT() with zero periods');
  if (rate === 0) return finish(-(pv + fv) / nper, env);
  const g = growth(rate, nper);
  const denom = (1 + rate * (ty !== 0 ? 1 : 0)) * (g - 1);
  if (denom === 0) return makeError('#DIV/0!', 'PMT() denominator is zero', origin(env), 'formula');
  return finish(-(rate * (fv + pv * g)) / denom, env);
}

function irr(args: ReadonlyArray<Arg>, env: EvalEnv): CellValue {
  const vals = numericList(args.slice(0, 1), env);
  if (!Array.isArray(vals)) return vals;
  const guess = num(args[1], env, 0.1);
  if (isCellError(guess)) return guess;
  if (!vals.some((v) => v > 0) || !vals.some((v) => v < 0)) return err(env, '#NUM!', 'IRR() needs at least one positive and one negative cash flow');
  let r = guess;
  for (let it = 0; it < 50; it++) {
    if (r <= -1) return err(env, '#NUM!', 'IRR() diverged below -100%');
    let f = 0;
    let df = 0;
    for (let t = 0; t < vals.length; t++) {
      const d = ipow(1 + r, t);
      const v = vals[t] ?? 0;
      f += v / d;
      df -= (t * v) / (d * (1 + r));
    }
    if (!Number.isFinite(f) || !Number.isFinite(df)) return err(env, '#NUM!', 'IRR() did not converge');
    if (df === 0) return err(env, '#NUM!', 'IRR() derivative is zero');
    const next = r - f / df;
    if (Math.abs(next - r) < 1e-10 && Math.abs(f) < 1e-6 * Math.max(1, ...vals.map(Math.abs))) return finish(next, env);
    r = next;
  }
  return err(env, '#NUM!', 'IRR() did not converge in 50 iterations');
}

/** Half away from zero on the shortest round-trip decimal representation (ROUND(1.005, 2) = 1.01). */
export function roundDecimal(x: number, digits: number): number {
  if (x === 0 || !Number.isFinite(x)) return x === 0 ? 0 : x;
  const sign = x < 0 ? -1 : 1;
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(Math.abs(x).toExponential());
  if (m === null) return x;
  const ds = (m[1] ?? '') + (m[2] ?? '');
  const exp = Number(m[3]);
  const keep = exp + 1 + digits;
  if (keep >= ds.length) return x;
  if (keep < 0) return 0;
  const head = ds.slice(0, keep);
  const roundUp = (ds.charCodeAt(keep) - 48) >= 5;
  const kept = BigInt(head === '' ? '0' : head) + (roundUp ? 1n : 0n);
  const v = Number(`${kept.toString()}e${exp + 1 - keep}`);
  return v === 0 ? 0 : sign * v;
}

/** Evaluates a formula AST to a single cell value. A top-level range is #VALUE! (no spilling). */
export function evaluateFormula(ast: FormulaAst, env: EvalEnv): CellValue {
  return scalar(ast, env);
}

/** Leaves on the evaluated path, in evaluation order. For IF: cond leaves, then only the taken branch's leaves. */
export function evaluatedLeaves(ast: FormulaAst, at: CellCoord, valueOf: (ref: ResolvedRef) => EvalArg): ReadonlyArray<EvaluatedLeaf> {
  const leaves: EvaluatedLeaf[] = [];
  evaluateFormula(ast, { at, valueOf, onLeaf: (l) => leaves.push(l) });
  return leaves;
}
