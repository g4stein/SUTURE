import { tableFromIPC } from 'apache-arrow';
import type { CellKey } from '../model/address.ts';
import { parseCellKey, toCellKey } from '../model/address.ts';
import { isCellError, type CellError, type CellValue, type ScalarValue } from '../model/values.ts';
import { assertCanonical, InvariantViolation } from '../boundary/normalize.ts';
import type { FormulaAst, ResolvedRef } from '../parse/ast.ts';
import { evaluatedLeaves, type EvalArg } from '../functions/evaluator.ts';
import type { EngineEvent, WorkbookEngine } from '../schedule/engine.ts';
import { encodeScalar } from './artifact.ts';
import type { AssertionOperand, CellAssertion, ValueSummary, ViolatedAssertion } from './types.ts';

export function crossEngineClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
}

function f64Equal(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length * 2);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length * 2);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function tableEqual(a: Uint8Array, b: Uint8Array): boolean {
  const ta = tableFromIPC(a);
  const tb = tableFromIPC(b);
  if (ta.numRows !== tb.numRows || ta.numCols !== tb.numCols) return false;
  const fa = ta.schema.fields;
  const fb = tb.schema.fields;
  for (let i = 0; i < fa.length; i++) {
    const x = fa[i];
    const y = fb[i];
    if (x === undefined || y === undefined || x.name !== y.name || String(x.type) !== String(y.type)) return false;
    const cx = ta.getChildAt(i);
    const cy = tb.getChildAt(i);
    if (cx === null || cy === null) return false;
    for (let r = 0; r < ta.numRows; r++) {
      const vx: unknown = cx.get(r);
      const vy: unknown = cy.get(r);
      if (typeof vx === 'number' && typeof vy === 'number') {
        if (!Object.is(vx, vy)) return false;
      } else if (vx instanceof Date || vy instanceof Date) {
        if (!(vx instanceof Date && vy instanceof Date && vx.getTime() === vy.getTime())) return false;
      } else if (vx !== vy) return false;
    }
  }
  return true;
}

/** Bit-identity for cell values (Spec 03 §4.2). */
export function sameValue(a: CellValue, b: CellValue): boolean {
  if (typeof a === 'number' || typeof b === 'number') return typeof a === 'number' && typeof b === 'number' && Object.is(a, b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'error' && b.kind === 'error') return a.code === b.code && a.origin === b.origin && a.engine === b.engine && a.message === b.message;
  if (a.kind === 'matrix' && b.kind === 'matrix') return a.rows === b.rows && a.cols === b.cols && f64Equal(a.data, b.data);
  if (a.kind === 'table' && b.kind === 'table') return a.rowCount === b.rowCount && tableEqual(a.ipc, b.ipc);
  return false;
}

export function summarize(v: CellValue): ValueSummary {
  if (v === null || typeof v !== 'object') return { kind: 'scalar', value: encodeScalar(v as ScalarValue) };
  switch (v.kind) {
    case 'error': return { kind: 'error', code: v.code, origin: v.origin as CellKey, engine: v.engine, message: v.message };
    case 'matrix': return { kind: 'matrix', rows: v.rows, cols: v.cols };
    case 'table': return { kind: 'table', rowCount: v.rowCount, columns: v.schema.map((f) => f.name) };
  }
}

function containsInterceptor(ast: FormulaAst): boolean {
  switch (ast.t) {
    case 'call': return ast.fn === 'IFERROR' || ast.fn === 'ISERROR' || ast.args.some(containsInterceptor);
    case 'unary': case 'percent': case 'paren': return containsInterceptor(ast.arg);
    case 'binary': return containsInterceptor(ast.left) || containsInterceptor(ast.right);
    default: return false;
  }
}

function sameError(a: CellError, b: CellError): boolean {
  return a.code === b.code && a.origin === b.origin && a.engine === b.engine;
}

type Look = (k: CellKey) => CellValue;

function refArg(ref: ResolvedRef, look: Look): EvalArg {
  if (ref.kind === 'unresolved') return { kind: 'scalar', value: null };
  if (ref.kind === 'cell') return { kind: 'scalar', value: look(toCellKey(ref.coord)) };
  const r = ref.range;
  const values: CellValue[] = [];
  for (let row = r.top; row <= r.bottom; row++) for (let col = r.left; col <= r.right; col++) values.push(look(toCellKey({ sheet: r.sheet, row, col })));
  return { kind: 'range', rows: r.bottom - r.top + 1, cols: r.right - r.left + 1, values };
}

function firstErrorOfArg(a: EvalArg): CellError | null {
  if (a.kind === 'scalar') return isCellError(a.value) ? a.value : null;
  for (const v of a.values) if (isCellError(v)) return v;
  return null;
}

/** Tier 1 propagation oracle for one cell (Spec 03 §4.2). Returns a detail string on violation. */
export function propagationViolation(engine: WorkbookEngine, key: CellKey, value: CellValue, look: Look): string | null {
  const parsed = engine.getParsed(key);
  if (parsed === null) return null;
  const coord = parseCellKey(key);
  if (coord === null) return null;
  let firstErr: CellError | null = null;
  if (parsed.dialect === 'formula' && 'ast' in parsed) {
    if (containsInterceptor(parsed.ast)) return null;
    for (const leaf of evaluatedLeaves(parsed.ast, coord, (ref) => refArg(ref, look))) {
      if (leaf.kind === 'errorLiteral') {
        firstErr = { kind: 'error', code: leaf.code, message: '', origin: key, engine: 'formula' };
        break;
      }
      if (leaf.ref.kind === 'unresolved') {
        firstErr = { kind: 'error', code: leaf.ref.code, message: '', origin: key, engine: 'formula' };
        break;
      }
      const e = firstErrorOfArg(refArg(leaf.ref, look));
      if (e !== null) {
        firstErr = e;
        break;
      }
    }
  } else if (parsed.dialect === 'sql' || parsed.dialect === 'py') {
    const refs = parsed.dialect === 'sql' ? parsed.template.slots.map((s) => s.ref) : parsed.program.inputKeys.map((k) => k.ref);
    for (const ref of refs) {
      const e = firstErrorOfArg(refArg(ref, look));
      if (e !== null) {
        firstErr = e;
        break;
      }
    }
    if (firstErr !== null && !(isCellError(value) && sameError(value, firstErr))) {
      return `${key} has upstream error ${firstErr.code} from ${firstErr.origin} but evaluated to ${isCellError(value) ? `${value.code} from ${value.origin}` : 'a non-error value'}`;
    }
    return null;
  } else {
    return null;
  }
  if (firstErr === null) return null;
  if (!isCellError(value)) return `${key} evaluated ${firstErr.code} from ${firstErr.origin} on its evaluated path but returned a non-error value`;
  if (value.origin !== key && !sameError(value, firstErr)) {
    return `${key} returned ${value.code} from ${value.origin}, but the first error on its evaluated path is ${firstErr.code} from ${firstErr.origin}`;
  }
  return null;
}

function operandValue(op: AssertionOperand, look: Look): CellValue {
  return op.kind === 'const' ? op.value : look(op.cell);
}

function numbersOf(v: CellValue): number[] | null {
  if (typeof v === 'number') return [v];
  if (v !== null && typeof v === 'object' && v.kind === 'matrix') return [...v.data];
  return null;
}

function tableHasNulls(v: CellValue, numericOnly: boolean): boolean {
  if (v === null || typeof v !== 'object' || v.kind !== 'table') return false;
  const t = tableFromIPC(v.ipc);
  for (let i = 0; i < t.numCols; i++) {
    const f = t.schema.fields[i];
    if (numericOnly && (f === undefined || !/^(Float|Int|Uint)/.test(String(f.type)))) continue;
    if ((t.getChildAt(i)?.nullCount ?? 0) > 0) return true;
  }
  return false;
}

/** Checks one Tier 2 assertion. `paired` is the value under the monotonic pair scenario (if any). */
export function assertionHolds(a: CellAssertion, look: Look, pairedLook: Look | null): { readonly ok: boolean; readonly detail: string } {
  const v = look(a.cell);
  const cmp = (x: number, y: number): boolean => {
    switch (a.kind) {
      case 'gte': return x >= y;
      case 'lte': return x <= y;
      case 'gt': return x > y;
      case 'lt': return x < y;
      default: return true;
    }
  };
  switch (a.kind) {
    case 'gte': case 'lte': case 'gt': case 'lt': {
      const xs = numbersOf(v);
      const y = operandValue(a.operand, look);
      if (xs === null || typeof y !== 'number') return { ok: false, detail: `${a.cell} is not a number` };
      const bad = xs.find((x) => !cmp(x, y));
      return bad === undefined ? { ok: true, detail: '' } : { ok: false, detail: `${a.cell} = ${String(bad)} violates ${a.kind} ${String(y)}` };
    }
    case 'between': {
      const xs = numbersOf(v);
      const lo = operandValue(a.min, look);
      const hi = operandValue(a.max, look);
      if (xs === null || typeof lo !== 'number' || typeof hi !== 'number') return { ok: false, detail: `${a.cell} is not a number` };
      const bad = xs.find((x) => x < lo || x > hi);
      return bad === undefined ? { ok: true, detail: '' } : { ok: false, detail: `${a.cell} = ${String(bad)} is outside [${String(lo)}, ${String(hi)}]` };
    }
    case 'notError':
      return isCellError(v) ? { ok: false, detail: `${a.cell} is ${v.code}: ${v.message}` } : { ok: true, detail: '' };
    case 'finite': {
      if (typeof v === 'number') return { ok: true, detail: '' };
      if (v !== null && typeof v === 'object' && (v.kind === 'matrix' || (v.kind === 'table' && !tableHasNulls(v, true)))) return { ok: true, detail: '' };
      return { ok: false, detail: `${a.cell} is not a finite numeric value (${isCellError(v) ? v.code : String(v)})` };
    }
    case 'notNull':
      if (v === null || tableHasNulls(v, false)) return { ok: false, detail: `${a.cell} is null or contains nulls` };
      return { ok: true, detail: '' };
    case 'monotonicWith': {
      if (pairedLook === null) return { ok: true, detail: '' };
      const x0 = look(a.cell);
      const x1 = pairedLook(a.cell);
      if (typeof x0 !== 'number' || typeof x1 !== 'number') return { ok: true, detail: '' };
      const ok = a.direction === 'nonDecreasing' ? x1 >= x0 : x1 <= x0;
      return ok ? { ok: true, detail: '' } : { ok: false, detail: `${a.cell} moved from ${String(x0)} to ${String(x1)} when ${a.input} increased (${a.direction})` };
    }
  }
}

export interface RunValues {
  readonly base: ReadonlyMap<CellKey, CellValue>;
  readonly pairs: ReadonlyArray<{ readonly assertionId: string; readonly values: ReadonlyMap<CellKey, CellValue> }>;
}

export interface ProbeComparison {
  readonly source: { readonly cell: CellKey; readonly binding: string; readonly column: string };
  readonly aggregate: 'sum' | 'mean' | 'min' | 'max' | 'count';
  readonly values: ReadonlyArray<{ readonly engine: 'formula' | 'sql' | 'py'; readonly value: number }>;
}

/** Checks Tier 1 (except determinism, which the runners own) then Tier 2, first violation wins. */
export function checkRun(input: {
  readonly engine: WorkbookEngine;
  readonly subgraph: ReadonlyArray<CellKey>;
  readonly run: RunValues;
  readonly fallback: (k: CellKey) => CellValue;
  readonly assertions: ReadonlyArray<CellAssertion>;
  readonly engineEvents: ReadonlyArray<EngineEvent>;
  readonly probes: ReadonlyArray<ProbeComparison>;
}): ViolatedAssertion | null {
  const lookIn = (m: ReadonlyMap<CellKey, CellValue>): Look => (k) => (m.has(k) ? (m.get(k) as CellValue) : input.fallback(k));
  const look = lookIn(input.run.base);
  const kernel = input.engineEvents.find((e) => e.kind === 'kernelException');
  if (kernel !== undefined && kernel.kind === 'kernelException') {
    return { tier: 1, invariant: 'T1.noUnhandledException', cell: kernel.key, detail: `${kernel.fn}() threw: ${kernel.message}` };
  }
  for (const k of input.subgraph) {
    try {
      assertCanonical(look(k));
    } catch (e) {
      if (e instanceof InvariantViolation) return { tier: 1, invariant: 'T1.noNonFiniteLeak', cell: k, detail: e.message };
      throw e;
    }
  }
  for (const k of input.subgraph) {
    const d = propagationViolation(input.engine, k, look(k), look);
    if (d !== null) return { tier: 1, invariant: 'T1.strictErrorPropagation', cell: k, detail: d };
  }
  for (const p of input.probes) {
    const [first, ...rest] = p.values;
    if (first === undefined) continue;
    for (const other of rest) {
      const ok = p.aggregate === 'count' ? first.value === other.value : crossEngineClose(first.value, other.value);
      if (!ok) {
        return {
          tier: 1, invariant: 'T1.crossEngineTolerance', cell: p.source.cell,
          detail: `${p.aggregate}(${p.source.binding}.${p.source.column}): ${first.engine}=${String(first.value)} vs ${other.engine}=${String(other.value)}`,
        };
      }
    }
  }
  for (const a of input.assertions) {
    const pair = a.kind === 'monotonicWith' ? input.run.pairs.find((p) => p.assertionId === a.id) : undefined;
    const res = assertionHolds(a, look, pair === undefined ? null : lookIn(pair.values));
    if (!res.ok) {
      return {
        tier: 2, assertion: a, observed: summarize(look(a.cell)),
        paired: pair === undefined ? null : summarize(lookIn(pair.values)(a.cell)), detail: res.detail,
      };
    }
  }
  return null;
}
