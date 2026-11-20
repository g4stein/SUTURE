import * as formulajs from '@formulajs/formulajs';
import type { CellCoord, CellKey } from '../model/address.ts';
import { toCellKey } from '../model/address.ts';
import { isCellError, makeError, type CellError, type CellErrorCode, type CellValue } from '../model/values.ts';
import { mapLibraryError } from '../boundary/libraryErrors.ts';
import { normalizeNumber } from '../boundary/normalize.ts';
import { ipow } from '../util/hash.ts';
import type { FormulaAst, ResolvedRef } from '../parse/ast.ts';

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

export type SupportedFunction = 'SUM' | 'AVERAGE' | 'MAX' | 'ROUND' | 'IF' | 'IFERROR' | 'ISERROR';

interface FunctionSpec {
  readonly name: SupportedFunction;
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly interceptsErrors: boolean;
  readonly kernel: 'formulajs' | 'native';
}

/**
 * Vertical-slice registry (7 of the 30 functions in Spec 01 Req 6.1). Every other name — including the
 * remaining 23 of the planned subset, which land in Phase 3 — resolves to #NAME?.
 */
export const FUNCTIONS: ReadonlyMap<SupportedFunction, FunctionSpec> = new Map<SupportedFunction, FunctionSpec>([
  ['SUM', { name: 'SUM', minArgs: 1, maxArgs: 255, interceptsErrors: false, kernel: 'formulajs' }],
  ['AVERAGE', { name: 'AVERAGE', minArgs: 1, maxArgs: 255, interceptsErrors: false, kernel: 'formulajs' }],
  ['MAX', { name: 'MAX', minArgs: 1, maxArgs: 255, interceptsErrors: false, kernel: 'formulajs' }],
  ['ROUND', { name: 'ROUND', minArgs: 2, maxArgs: 2, interceptsErrors: false, kernel: 'native' }],
  ['IF', { name: 'IF', minArgs: 2, maxArgs: 3, interceptsErrors: false, kernel: 'native' }],
  ['IFERROR', { name: 'IFERROR', minArgs: 2, maxArgs: 2, interceptsErrors: true, kernel: 'native' }],
  ['ISERROR', { name: 'ISERROR', minArgs: 1, maxArgs: 1, interceptsErrors: true, kernel: 'native' }],
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

function finish(x: number, env: EvalEnv): number | CellError {
  return normalizeNumber(x, 'none', origin(env), 'formula');
}

/** Evaluates to a scalar; a range in scalar position is #VALUE!. */
function scalar(ast: FormulaAst, env: EvalEnv): CellValue {
  const a = evalNode(ast, env);
  if (a.kind === 'range') return err(env, '#VALUE!', 'a range cannot be used where a single value is required');
  return a.value;
}

function typeRank(v: number | string | boolean): number {
  return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
}

function compare(a: CellValue, b: CellValue, env: EvalEnv): number | CellError {
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
      const c = compare(l, r, env);
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
    case 'num':
      return { kind: 'scalar', value: ast.v };
    case 'str':
      return { kind: 'scalar', value: ast.v };
    case 'bool':
      return { kind: 'scalar', value: ast.v };
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
      const v = scalar(ast.arg, env);
      const n = toNumber(v, env);
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

function call(ast: Extract<FormulaAst, { t: 'call' }>, env: EvalEnv): CellValue {
  const spec = lookupFunction(ast.fn);
  if (spec === null) return err(env, '#NAME?', `unknown or unsupported function ${ast.fn}()`);
  if (ast.args.length < spec.minArgs || ast.args.length > spec.maxArgs) {
    return err(env, '#VALUE!', `${ast.fn}() takes ${spec.minArgs === spec.maxArgs ? spec.minArgs : `${spec.minArgs}–${spec.maxArgs}`} arguments`);
  }
  if (spec.name === 'IF') return ifFn(ast.args, env);
  // Every other function evaluates all of its arguments eagerly, left to right.
  const args = ast.args.map((a) => evalNode(a, env));
  try {
    if (spec.name === 'IFERROR') {
      const [v, fb] = args;
      if (v === undefined || fb === undefined || v.kind === 'range' || fb.kind === 'range') return err(env, '#VALUE!', 'IFERROR() takes single values');
      return isCellError(v.value) ? fb.value : v.value;
    }
    if (spec.name === 'ISERROR') {
      const [v] = args;
      if (v === undefined || v.kind === 'range') return err(env, '#VALUE!', 'ISERROR() takes a single value');
      return isCellError(v.value);
    }
    const e = firstError(args);
    if (e !== null) return e;
    if (spec.name === 'ROUND') return round(args, env);
    return aggregate(spec.name, ast.args, args, env);
  } catch (ex) {
    const message = ex instanceof Error ? ex.message : String(ex);
    env.onKernelException?.(spec.name, message);
    return err(env, '#VALUE!', `internal: ${spec.name}`);
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

function numericMembers(argAst: FormulaAst, arg: EvalArg, env: EvalEnv): number[] | CellError {
  const isRefArg = argAst.t === 'ref' || (argAst.t === 'paren' && argAst.arg.t === 'ref');
  const out: number[] = [];
  const pushMember = (v: CellValue): CellError | null => {
    if (typeof v === 'number') out.push(v);
    else if (v !== null && typeof v === 'object') {
      if (v.kind === 'matrix') for (const x of v.data) out.push(x);
      else if (v.kind === 'table') return err(env, '#VALUE!', 'a table cannot be aggregated directly');
    }
    return null;
  };
  if (arg.kind === 'range') {
    for (const v of arg.values) {
      const e = pushMember(v);
      if (e !== null) return e;
    }
    return out;
  }
  if (isRefArg) {
    const e = pushMember(arg.value);
    return e ?? out;
  }
  const v = arg.value;
  if (v !== null && typeof v === 'object' && v.kind === 'matrix') {
    for (const x of v.data) out.push(x);
    return out;
  }
  const n = toNumber(v, env);
  if (isCellError(n)) return n;
  out.push(n);
  return out;
}

function fromLibrary(result: unknown, env: EvalEnv): CellValue {
  if (result instanceof Error) return mapLibraryError(result.message, origin(env));
  if (typeof result === 'number') return finish(result, env);
  throw new Error(`unexpected formulajs result ${typeof result}`);
}

function aggregate(name: 'SUM' | 'AVERAGE' | 'MAX', asts: ReadonlyArray<FormulaAst>, args: ReadonlyArray<EvalArg>, env: EvalEnv): CellValue {
  const nums: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const node = asts[i];
    if (a === undefined || node === undefined) continue;
    const m = numericMembers(node, a, env);
    if (!Array.isArray(m)) return m;
    for (const x of m) nums.push(x);
  }
  if (name === 'AVERAGE' && nums.length === 0) return makeError('#DIV/0!', 'AVERAGE() of no numbers', origin(env), 'formula');
  if (name === 'MAX' && nums.length === 0) return 0;
  const kernel = name === 'SUM' ? formulajs.SUM : name === 'AVERAGE' ? formulajs.AVERAGE : formulajs.MAX;
  return fromLibrary(kernel(nums), env);
}

/** Half away from zero on the shortest round-trip decimal representation (ROUND(1.005, 2) = 1.01). */
export function roundDecimal(x: number, digits: number): number {
  if (x === 0 || !Number.isFinite(x)) return x === 0 ? 0 : x;
  const sign = x < 0 ? -1 : 1;
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(Math.abs(x).toExponential());
  if (m === null) return x;
  const ds = (m[1] ?? '') + (m[2] ?? '');
  const exp = Number(m[3]);
  const keep = exp + 1 + digits; // number of significant digits to keep
  if (keep >= ds.length) return x;
  if (keep < 0) return 0;
  const head = ds.slice(0, keep);
  const roundUp = (ds.charCodeAt(keep) - 48) >= 5;
  const kept = BigInt(head === '' ? '0' : head) + (roundUp ? 1n : 0n);
  const v = Number(`${kept.toString()}e${exp + 1 - keep}`);
  return v === 0 ? 0 : sign * v;
}

function round(args: ReadonlyArray<EvalArg>, env: EvalEnv): CellValue {
  const [xa, da] = args;
  if (xa === undefined || da === undefined || xa.kind === 'range' || da.kind === 'range') return err(env, '#VALUE!', 'ROUND() takes single values');
  const x = toNumber(xa.value, env);
  if (isCellError(x)) return x;
  const d = toNumber(da.value, env);
  if (isCellError(d)) return d;
  const digits = Math.trunc(d);
  if (digits < -308 || digits > 308) return err(env, '#NUM!', 'ROUND() digits out of range');
  return finish(roundDecimal(x, digits), env);
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
