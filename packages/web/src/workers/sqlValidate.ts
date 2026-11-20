/** Spec 02 §5.3 — cell-query validation. Both validators are pure and deterministic. */
export type SqlValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type SqlValidatorKind = 'ast' | 'lexical';

export const ALLOWED_TABLE_FUNCTIONS: ReadonlySet<string> = new Set(['range', 'generate_series', 'unnest']);

/** Removes `query_location` fields (uint64, may exceed 2^53) before JSON.parse, so no precision is ever lost. */
export function parseSerializedSql(text: string): unknown {
  return JSON.parse(text.replace(/"query_location":\d+,?/g, '').replace(/,}/g, '}'));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ------------------------------------------------------------------ §5.3.1 AST validator

export function validateSerializedSql(json: unknown, allowedTables: ReadonlySet<string>): SqlValidation {
  if (!isObj(json)) return { ok: false, reason: 'serializer returned no object' };
  if (json['error'] !== false) {
    const msg = typeof json['error_message'] === 'string' ? json['error_message'] : 'not serializable';
    return { ok: false, reason: `only a single SELECT statement is allowed (${msg})` };
  }
  const stmts = json['statements'];
  if (!Array.isArray(stmts) || stmts.length !== 1) return { ok: false, reason: 'exactly one statement is allowed' };
  const allowed = new Set([...allowedTables].map((t) => t.toLowerCase()));
  const ctes = new Set<string>();
  const collectCtes = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) collectCtes(x); return; }
    if (!isObj(v)) return;
    const cm = v['cte_map'];
    if (isObj(cm) && Array.isArray(cm['map'])) for (const e of cm['map']) if (isObj(e) && typeof e['key'] === 'string') ctes.add(e['key'].toLowerCase());
    for (const x of Object.values(v)) collectCtes(x);
  };
  collectCtes(stmts);
  let failure: string | null = null;
  const walk = (v: unknown): void => {
    if (failure !== null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!isObj(v)) return;
    if (v['type'] === 'BASE_TABLE') {
      const name = String(v['table_name'] ?? '').toLowerCase();
      const schema = String(v['schema_name'] ?? '').toLowerCase();
      const catalog = String(v['catalog_name'] ?? '');
      if (catalog !== '' || !['', 'main', 'temp'].includes(schema)) failure = `table ${name} must not be qualified with a catalog or schema`;
      else if (name.startsWith('__res_') || !(allowed.has(name) || ctes.has(name))) failure = `table "${name}" is not a registered dataset or binding`;
    } else if (v['type'] === 'TABLE_FUNCTION') {
      const fn = isObj(v['function']) ? String(v['function']['function_name'] ?? '').toLowerCase() : '';
      if (!ALLOWED_TABLE_FUNCTIONS.has(fn)) failure = `table function ${fn}() is not allowed`;
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(stmts);
  return failure === null ? { ok: true } : { ok: false, reason: failure };
}

// ------------------------------------------------------------------ §5.3.2 lexical guard

type Tok =
  | { readonly k: 'word'; readonly v: string; readonly at: number; readonly quoted: boolean }
  | { readonly k: 'string'; readonly at: number }
  | { readonly k: 'num'; readonly at: number }
  | { readonly k: 'param'; readonly at: number }
  | { readonly k: 'punct'; readonly v: string; readonly at: number };

const DENIED = new Set(
  'INSERT UPDATE DELETE MERGE UPSERT CREATE DROP ALTER TRUNCATE REPLACE COPY ATTACH DETACH PRAGMA SET RESET INSTALL LOAD EXPORT IMPORT CALL CHECKPOINT VACUUM BEGIN COMMIT ROLLBACK TRANSACTION USE GRANT REVOKE PREPARE EXECUTE DEALLOCATE SUMMARIZE DESCRIBE SHOW EXPLAIN PIVOT UNPIVOT'.split(' '),
);
const CLAUSE_END = new Set('WHERE GROUP HAVING ORDER LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT ON USING'.split(' '));
const EXTERNAL_PREFIX = ['read_', 'parquet_', 'sqlite_', 'postgres_', 'mysql_', 'iceberg_', 'delta_', 'duckdb_'];
const EXTERNAL_NAMES = new Set(['glob', 'sniff_csv', 'query', 'query_table', 'getenv']);

class LexError extends Error {
  constructor(readonly rule: number, readonly at: number, message: string) {
    super(message);
  }
}

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? '';
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new LexError(1, i, 'unterminated block comment');
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const at = i;
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= sql.length) throw new LexError(1, at, ch === "'" ? 'unterminated string' : 'unterminated quoted identifier');
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { v += ch; j += 2; continue; }
          break;
        }
        v += sql[j];
        j++;
      }
      out.push(ch === "'" ? { k: 'string', at } : { k: 'word', v, at, quoted: true });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$\d+/.exec(sql.slice(i));
      if (m === null) throw new LexError(2, i, 'dollar-quoted strings are not allowed');
      out.push({ k: 'param', at: i });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i));
      out.push({ k: 'num', at: i });
      i += m?.[0].length ?? 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      const v = m?.[0] ?? ch;
      out.push({ k: 'word', v, at: i, quoted: false });
      i += v.length;
      continue;
    }
    out.push({ k: 'punct', v: ch, at: i });
    i++;
  }
  return out;
}

const up = (t: Tok | undefined): string => (t !== undefined && t.k === 'word' && !t.quoted ? t.v.toUpperCase() : '');
const isP = (t: Tok | undefined, v: string): boolean => t !== undefined && t.k === 'punct' && t.v === v;

export function validateLexical(sql: string, allowedTables: ReadonlySet<string>): SqlValidation {
  try {
    const toks = tokenize(sql);
    // rule 3: single statement (one trailing ';' allowed)
    const semis = toks.map((t, i) => (isP(t, ';') ? i : -1)).filter((i) => i >= 0);
    if (semis.length > 1 || (semis.length === 1 && semis[0] !== toks.length - 1)) {
      throw new LexError(3, semis.length > 0 ? (toks[semis[0] ?? 0]?.at ?? 0) : 0, 'only a single statement is allowed');
    }
    const body = semis.length === 1 ? toks.slice(0, -1) : toks;
    // rule 4: read-only start
    const first = up(body[0]);
    if (first !== 'SELECT' && first !== 'WITH') throw new LexError(4, body[0]?.at ?? 0, 'queries must start with SELECT or WITH');
    // rule 5: denied keywords
    for (const t of body) {
      if (DENIED.has(up(t))) throw new LexError(5, t.at, `keyword ${up(t)} is not allowed (double-quote identifiers with this name)`);
    }
    // CTE names: depth-0 identifiers after WITH / RECURSIVE / ',' inside the WITH list, then [(cols)] AS [NOT] [MATERIALIZED] (
    const ctes = new Set<string>();
    if (first === 'WITH') {
      let depth = 0;
      let expectName = true;
      for (let i = 1; i < body.length; i++) {
        const t = body[i];
        if (isP(t, '(')) depth++;
        else if (isP(t, ')')) depth--;
        if (depth !== 0) continue;
        const u = up(t);
        if (u === 'SELECT') break;
        if (u === 'RECURSIVE' && i === 1) continue;
        if (isP(t, ',')) { expectName = true; continue; }
        if (expectName && t !== undefined && t.k === 'word') {
          let j = i + 1;
          if (isP(body[j], '(')) {
            let d = 0;
            for (; j < body.length; j++) {
              if (isP(body[j], '(')) d++;
              else if (isP(body[j], ')') && --d === 0) { j++; break; }
            }
          }
          if (up(body[j]) === 'AS') {
            let k = j + 1;
            if (up(body[k]) === 'NOT') k++;
            if (up(body[k]) === 'MATERIALIZED') k++;
            if (isP(body[k], '(')) ctes.add(t.v.toLowerCase());
          }
          expectName = false;
        }
      }
    }
    const allowed = new Set([...allowedTables].map((x) => x.toLowerCase()));
    // rule 7: external readers anywhere (defense in depth)
    for (let i = 0; i < body.length; i++) {
      const t = body[i];
      if (t?.k !== 'word' || !isP(body[i + 1], '(')) continue;
      const name = t.v.toLowerCase();
      if (EXTERNAL_NAMES.has(name) || EXTERNAL_PREFIX.some((p) => name.startsWith(p))) throw new LexError(7, t.at, `${name}() reads external data and is not allowed`);
    }
    // rule 6: table positions
    const depthAt: number[] = [];
    let d = 0;
    for (const t of body) {
      if (isP(t, '(')) d++;
      depthAt.push(d);
      if (isP(t, ')')) d--;
    }
    const checkTable = (i: number): void => {
      const t = body[i];
      if (t === undefined) throw new LexError(6, sql.length, 'missing table after FROM/JOIN');
      if (isP(t, '(')) return; // subquery, validated by the same rules (they apply to the whole token stream)
      if (t.k === 'string') throw new LexError(6, t.at, 'string literals cannot be used as tables (file and URL scans are not allowed)');
      if (t.k !== 'word') throw new LexError(6, t.at, 'expected a table name');
      if (isP(body[i + 1], '.')) throw new LexError(6, t.at, 'qualified table names are not allowed');
      const name = t.v.toLowerCase();
      if (!t.quoted && ALLOWED_TABLE_FUNCTIONS.has(name) && isP(body[i + 1], '(')) return;
      if (isP(body[i + 1], '(')) throw new LexError(6, t.at, `table function ${name}() is not allowed`);
      if (name.startsWith('__res_') || !(allowed.has(name) || ctes.has(name))) throw new LexError(6, t.at, `table "${name}" is not a registered dataset or binding`);
    };
    for (let i = 0; i < body.length; i++) {
      const u = up(body[i]);
      if (u === 'FROM' || u === 'JOIN') {
        checkTable(i + 1);
        if (u === 'FROM') {
          // comma-separated FROM list at the same depth
          const depth = depthAt[i] ?? 0;
          for (let j = i + 1; j < body.length; j++) {
            const tj = body[j];
            if ((depthAt[j] ?? 0) < depth || (isP(tj, ')') && (depthAt[j] ?? 0) === depth)) break;
            if ((depthAt[j] ?? 0) !== depth) continue;
            if (CLAUSE_END.has(up(tj)) || up(tj) === 'SELECT') break;
            if (isP(tj, ',')) checkTable(j + 1);
          }
        }
      }
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof LexError) return { ok: false, reason: `lexical guard rule ${e.rule} at offset ${e.at}: ${e.message}` };
    throw e;
  }
}
