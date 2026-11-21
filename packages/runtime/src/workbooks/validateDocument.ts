import { parseCellKey, type SutureDocument } from '@suture/core';

/**
 * Spec 04 §6.1 — validates an untrusted `.suture.json` value field by field. Returns the first failing path so the
 * rejection message can name it (Req 6.4). Nothing in the value is trusted until this returns ok.
 */
export type DocumentCheck = { readonly ok: true; readonly document: SutureDocument } | { readonly ok: false; readonly path: string; readonly message: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isKey = (v: unknown): boolean => typeof v === 'string' && parseCellKey(v) !== null;
const isScalar = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'boolean' || isFiniteNum(v);

class Invalid extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

function need(cond: boolean, path: string, message: string): void {
  if (!cond) throw new Invalid(path, message);
}

function coord(v: unknown, path: string): void {
  need(isObj(v), path, 'must be an object');
  const o = v as Obj;
  need(typeof o['sheet'] === 'string', `${path}.sheet`, 'must be a string');
  need(Number.isInteger(o['row']) && Number.isInteger(o['col']), path, 'row and col must be integers');
}

function operand(v: unknown, path: string): void {
  need(isObj(v), path, 'must be an object');
  const o = v as Obj;
  if (o['kind'] === 'const') need(isFiniteNum(o['value']), `${path}.value`, 'must be a finite number');
  else if (o['kind'] === 'cell') need(isKey(o['cell']), `${path}.cell`, 'must be a cell key like Sheet1!A1');
  else throw new Invalid(`${path}.kind`, "must be 'const' or 'cell'");
}

function check(v: unknown): SutureDocument {
  need(isObj(v), '$', 'must be a JSON object');
  const d = v as Obj;
  need(d['format'] === 'suture.workbook', '$.format', "must be 'suture.workbook'");
  need(d['version'] === 1, '$.version', 'must be 1');
  need(typeof d['title'] === 'string', '$.title', 'must be a string');

  need(isObj(d['workbook']), '$.workbook', 'must be an object');
  const wb = d['workbook'] as Obj;
  need(Array.isArray(wb['sheets']) && (wb['sheets'] as unknown[]).length > 0, '$.workbook.sheets', 'must be a non-empty array');
  (wb['sheets'] as unknown[]).forEach((s, i) => {
    const p = `$.workbook.sheets[${i}]`;
    need(isObj(s), p, 'must be an object');
    const so = s as Obj;
    need(typeof so['name'] === 'string' && (so['name'] as string).length > 0, `${p}.name`, 'must be a non-empty string');
    need(Array.isArray(so['cells']), `${p}.cells`, 'must be an array');
    (so['cells'] as unknown[]).forEach((c, j) => {
      const cp = `${p}.cells[${j}]`;
      need(isObj(c), cp, 'must be an object');
      const co = c as Obj;
      need(isKey(co['key']), `${cp}.key`, 'must be a cell key like Sheet1!A1');
      need(typeof co['raw'] === 'string', `${cp}.raw`, 'must be a string');
      if ('literal' in co) need(isScalar(co['literal']), `${cp}.literal`, 'must be a scalar');
    });
  });
  need(Array.isArray(wb['names']), '$.workbook.names', 'must be an array');
  (wb['names'] as unknown[]).forEach((n, i) => {
    const p = `$.workbook.names[${i}]`;
    need(isObj(n) && typeof (n as Obj)['name'] === 'string' && isObj((n as Obj)['target']), p, 'must be { name, target }');
    const t = (n as Obj)['target'] as Obj;
    if (t['kind'] === 'cell') coord(t['coord'], `${p}.target.coord`);
    else if (t['kind'] === 'range') need(isObj(t['range']), `${p}.target.range`, 'must be an object');
    else throw new Invalid(`${p}.target.kind`, "must be 'cell' or 'range'");
  });
  need(Array.isArray(wb['datasets']), '$.workbook.datasets', 'must be an array');
  (wb['datasets'] as unknown[]).forEach((m, i) => {
    const p = `$.workbook.datasets[${i}]`;
    need(isObj(m), p, 'must be an object');
    const mo = m as Obj;
    need(typeof mo['name'] === 'string' && typeof mo['sha256'] === 'string' && Number.isInteger(mo['rowCount']) && Array.isArray(mo['schema']), p, 'must be a dataset description');
  });
  need(Number.isInteger(wb['seed']), '$.workbook.seed', 'must be an integer');

  need(isObj(d['exorcist']), '$.exorcist', 'must be an object');
  const x = d['exorcist'] as Obj;
  for (const k of ['numRuns', 'batchSize', 'maxBatches'] as const) need(isPosInt(x[k]), `$.exorcist.${k}`, 'must be a positive integer');
  need(Number.isInteger(x['maxShrinkRounds']) && (x['maxShrinkRounds'] as number) >= 0, '$.exorcist.maxShrinkRounds', 'must be a non-negative integer');
  need(Array.isArray(x['inputs']), '$.exorcist.inputs', 'must be an array');
  (x['inputs'] as unknown[]).forEach((inp, i) => {
    const p = `$.exorcist.inputs[${i}]`;
    need(isObj(inp), p, 'must be an object');
    const io = inp as Obj;
    need(isKey(io['cell']), `${p}.cell`, 'must be a cell key');
    need(isObj(io['domain']), `${p}.domain`, 'must be an object');
    const dm = io['domain'] as Obj;
    if (dm['kind'] === 'float' || dm['kind'] === 'integer') need(isFiniteNum(dm['min']) && isFiniteNum(dm['max']) && (dm['min'] as number) <= (dm['max'] as number), `${p}.domain`, 'needs finite min ≤ max');
    else if (dm['kind'] === 'choice') need(Array.isArray(dm['values']) && (dm['values'] as unknown[]).every(isScalar), `${p}.domain.values`, 'must be an array of scalars');
    else need(dm['kind'] === 'boolean', `${p}.domain.kind`, "must be 'float', 'integer', 'choice', or 'boolean'");
  });
  need(Array.isArray(x['assertions']), '$.exorcist.assertions', 'must be an array');
  (x['assertions'] as unknown[]).forEach((a, i) => {
    const p = `$.exorcist.assertions[${i}]`;
    need(isObj(a), p, 'must be an object');
    const ao = a as Obj;
    need(typeof ao['id'] === 'string' && (ao['id'] as string).length > 0, `${p}.id`, 'must be a non-empty string');
    need(isKey(ao['cell']), `${p}.cell`, 'must be a cell key');
    switch (ao['kind']) {
      case 'gte': case 'lte': case 'gt': case 'lt': operand(ao['operand'], `${p}.operand`); break;
      case 'between': operand(ao['min'], `${p}.min`); operand(ao['max'], `${p}.max`); break;
      case 'notError': case 'finite': case 'notNull': break;
      case 'monotonicWith':
        need(isKey(ao['input']), `${p}.input`, 'must be a cell key');
        need(ao['direction'] === 'nonDecreasing' || ao['direction'] === 'nonIncreasing', `${p}.direction`, "must be 'nonDecreasing' or 'nonIncreasing'");
        break;
      default: throw new Invalid(`${p}.kind`, 'is not one of the 9 assertion kinds');
    }
  });
  // Every field has been checked against the SutureDocument shape above.
  return v as unknown as SutureDocument;
}

export function validateDocument(v: unknown): DocumentCheck {
  try {
    return { ok: true, document: check(v) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, message: e.message };
    throw e;
  }
}

export function isSutureDocument(v: unknown): v is SutureDocument {
  return validateDocument(v).ok;
}
