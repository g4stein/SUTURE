import type { CellError, CellValue } from '../model/values.ts';

/** A compiled criterion (Spec 01 §6.4): tests one range member. Error members never reach it (they propagate first). */
export type Criterion = (member: CellValue) => boolean;

const NUMBER_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const OPS = ['>=', '<=', '<>', '=', '>', '<'] as const;
type Op = (typeof OPS)[number];

/** `*` any run, `?` one character, `~` escapes the next character. Compiled on locale-free lowercased text. */
function wildcard(pattern: string): RegExp | null {
  if (!/[*?~]/.test(pattern)) return null;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '~' && i + 1 < pattern.length) {
      src += (pattern[++i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') src += '[\\s\\S]*';
    else if (ch === '?') src += '[\\s\\S]';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'u');
}

function cmp(op: Op, c: number): boolean {
  switch (op) {
    case '=': return c === 0;
    case '<>': return c !== 0;
    case '<': return c < 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '>=': return c >= 0;
  }
}

/**
 * Compiles a criterion value:
 * - number / boolean: equality with members of the same type;
 * - string: optional operator (`= <> < > <= >=`) then an operand. A numeric operand compares numerically against number
 *   members (`<>` also matches every non-number member). `TRUE`/`FALSE` compare against booleans. Any other operand compares
 *   case-insensitively against string members, with `* ? ~` wildcards for `=` and `<>`. An empty operand matches blank
 *   members (`null` or `""`) for `=`, and non-blank members for `<>`.
 */
export function compileCriterion(c: CellValue, invalid: (message: string) => CellError): Criterion | CellError {
  if (c === null) return (m) => m === null || m === '';
  if (typeof c === 'number') return (m) => typeof m === 'number' && m === c;
  if (typeof c === 'boolean') return (m) => m === c;
  if (typeof c !== 'string') return c.kind === 'error' ? c : invalid('criteria must be a single value');
  const op: Op = OPS.find((o) => c.startsWith(o)) ?? '=';
  const operand = OPS.some((o) => c.startsWith(o)) ? c.slice(op.length) : c;
  if (operand === '') {
    if (op === '=') return (m) => m === null || m === '';
    if (op === '<>') return (m) => m !== null && m !== '';
    return () => false;
  }
  if (NUMBER_LITERAL.test(operand.trim()) && Number.isFinite(Number(operand))) {
    const n = Number(operand);
    if (op === '<>') return (m) => typeof m !== 'number' || m !== n;
    return (m) => typeof m === 'number' && cmp(op, m < n ? -1 : m > n ? 1 : 0);
  }
  const up = operand.toUpperCase();
  if (up === 'TRUE' || up === 'FALSE') {
    const b = up === 'TRUE';
    if (op === '<>') return (m) => m !== b;
    return (m) => typeof m === 'boolean' && cmp(op, Number(m) - Number(b));
  }
  const lower = operand.toLowerCase();
  const re = op === '=' || op === '<>' ? wildcard(lower) : null;
  if (re !== null) {
    if (op === '=') return (m) => typeof m === 'string' && re.test(m.toLowerCase());
    return (m) => !(typeof m === 'string' && re.test(m.toLowerCase()));
  }
  if (op === '<>') return (m) => !(typeof m === 'string' && m.toLowerCase() === lower);
  return (m) => {
    if (typeof m !== 'string') return false;
    const x = m.toLowerCase();
    return cmp(op, x < lower ? -1 : x > lower ? 1 : 0);
  };
}
