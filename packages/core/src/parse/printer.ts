import type { FormulaAst } from './ast.ts';

const BP: Readonly<Record<string, number>> = {
  '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10, '&': 20, '+': 30, '-': 30, '*': 40, '/': 40, '^': 50,
};

function wrap(a: FormulaAst): FormulaAst {
  return { t: 'paren', arg: a };
}

/**
 * Inserts the `paren` nodes that printing needs, so that parse(print(n)) ≡ n for n = withRequiredParens(ast).
 * Parsed ASTs already satisfy this; generated ASTs (property tests) are normalized through it. Idempotent.
 */
export function withRequiredParens(ast: FormulaAst): FormulaAst {
  switch (ast.t) {
    case 'unary': {
      const arg = withRequiredParens(ast.arg);
      return { t: 'unary', op: ast.op, arg: arg.t === 'binary' || arg.t === 'percent' ? wrap(arg) : arg };
    }
    case 'percent': {
      const arg = withRequiredParens(ast.arg);
      return { t: 'percent', arg: arg.t === 'binary' ? wrap(arg) : arg };
    }
    case 'binary': {
      const bp = BP[ast.op] ?? 0;
      const left = withRequiredParens(ast.left);
      const right = withRequiredParens(ast.right);
      const lNeeds = left.t === 'binary' && (BP[left.op] ?? 0) < bp;
      const rNeeds = right.t === 'binary' && (BP[right.op] ?? 0) <= bp;
      return { t: 'binary', op: ast.op, left: lNeeds ? wrap(left) : left, right: rNeeds ? wrap(right) : right };
    }
    case 'call':
      return { t: 'call', fn: ast.fn, args: ast.args.map(withRequiredParens) };
    case 'paren':
      return { t: 'paren', arg: withRequiredParens(ast.arg) };
    default:
      return ast;
  }
}

function printNumber(v: number): string {
  return Object.is(v, -0) ? '0' : String(v);
}

/** Prints an AST back to formula source (without the leading "="). parse(print(ast)) ≡ ast. */
export function printFormula(ast: FormulaAst): string {
  switch (ast.t) {
    case 'num':
      return printNumber(ast.v);
    case 'str':
      return `"${ast.v.replaceAll('"', '""')}"`;
    case 'bool':
      return ast.v ? 'TRUE' : 'FALSE';
    case 'err':
      return ast.code;
    case 'ref':
      return ast.ref.text;
    case 'name':
      return ast.name;
    case 'unary':
      return `${ast.op}${printFormula(ast.arg)}`;
    case 'percent':
      return `${printFormula(ast.arg)}%`;
    case 'binary':
      return `${printFormula(ast.left)}${ast.op}${printFormula(ast.right)}`;
    case 'call':
      return `${ast.fn}(${ast.args.map(printFormula).join(',')})`;
    case 'paren':
      return `(${printFormula(ast.arg)})`;
  }
}
