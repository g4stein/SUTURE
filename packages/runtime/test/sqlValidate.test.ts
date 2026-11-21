import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection } from 'duckdb-wasm-blocking';
import { parseSerializedSql, validateLexical, validateSerializedSql } from '../src/engines/sqlValidate.ts';
import { openNodeDuckDB } from '../src/node/engines.ts';

let conn: DuckDBConnection;
let astAvailable = false;
const probe: { shipped: string; afterLoad: string; duckdb: string } = { shipped: '', afterLoad: '', duckdb: '' };

beforeAll(async () => {
  conn = (await openNodeDuckDB()).conn;
  probe.duckdb = String(conn.query('SELECT version() AS v').getChildAt(0)?.get(0));
  // Same settings as the DuckDB worker: no implicit extension autoload/autoinstall.
  conn.query('SET autoinstall_known_extensions = false');
  conn.query('SET autoload_known_extensions = false');
  try {
    conn.query("SELECT json_serialize_sql('SELECT 1') AS j");
    probe.shipped = 'present';
  } catch (e) {
    probe.shipped = `absent (${(e as Error).message.split('\n')[0]?.slice(0, 80)})`;
  }
  try {
    conn.query('INSTALL json');
    conn.query('LOAD json');
    conn.query("SELECT json_serialize_sql('SELECT 1', skip_default := true) AS j");
    astAvailable = true;
    probe.afterLoad = 'available after explicit INSTALL/LOAD json';
  } catch (e) {
    probe.afterLoad = `unavailable: ${(e as Error).message.slice(0, 80)}`;
  }
  console.info(`[probe] DuckDB ${probe.duckdb}; json_serialize_sql in shipped bundle: ${probe.shipped}; ${probe.afterLoad}`);
});

const ALLOWED = new Set(['__suture_b0', 'orders']);

function ast(sql: string): { ok: boolean; reason: string; parserError: boolean } {
  const stmt = conn.prepare('SELECT json_serialize_sql($1::VARCHAR, skip_default := true, skip_null := true, skip_empty := true) AS j');
  try {
    const text = String(stmt.query(sql).getChildAt(0)?.get(0) ?? '');
    const json = parseSerializedSql(text) as { error?: boolean; error_type?: string };
    const v = validateSerializedSql(json, ALLOWED);
    return { ok: v.ok, reason: v.ok ? '' : v.reason, parserError: json.error === true && json.error_type === 'parser' };
  } finally {
    stmt.close();
  }
}

const ACCEPT = [
  'SELECT 1',
  'SELECT * FROM __suture_b0',
  'select a, b from orders where a > $1',
  'WITH t AS (SELECT 1 AS a) SELECT * FROM t',
  'WITH t(x) AS MATERIALIZED (SELECT 1) SELECT x FROM t',
  'SELECT * FROM range(10) r(i)',
  'SELECT * FROM generate_series(1, 3)',
  "SELECT 'a;b' AS s FROM orders;",
  'SELECT count(*) FROM orders o JOIN __suture_b0 b ON o.a = b.a',
  'SELECT * FROM (SELECT * FROM orders) s',
];
const REJECT = [
  'CREATE TABLE x(a INT)', 'COPY orders TO \'x.csv\'', "ATTACH 'x.db'", 'PRAGMA version', 'SET threads = 4',
  'SELECT 1; SELECT 2', "SELECT * FROM 'x.csv'", 'SELECT * FROM "x.csv"', "SELECT * FROM 'https://example.com/x.parquet'",
  "SELECT * FROM read_csv('x.csv')", 'SELECT * FROM __res_0', 'SELECT * FROM __suture_b1', 'SELECT * FROM other.orders',
  'SELECT * FROM missing_table', "SELECT * FROM read_parquet('x')", 'SELECT * FROM glob(\'*\')',
  'SELECT 1 /* ; */ ; DROP TABLE orders', 'INSERT INTO orders VALUES (1)', 'EXPLAIN SELECT 1',
];

describe('SQL validators (Spec 02 §5.3)', () => {
  it('lexical guard: accepts read-only SELECTs over allowed tables', () => {
    for (const q of ACCEPT) expect(validateLexical(q, ALLOWED), q).toEqual({ ok: true });
  });
  it('lexical guard: rejects every forbidden class', () => {
    for (const q of REJECT) expect(validateLexical(q, ALLOWED).ok, q).toBe(false);
    expect(validateLexical('SELECT $$x$$', ALLOWED).ok).toBe(false);
  });
  it('AST validator agrees on the fixed table (when json_serialize_sql is available)', () => {
    if (!astAvailable) return;
    for (const q of ACCEPT) expect(ast(q).ok, q).toBe(true);
    for (const q of REJECT) expect(ast(q).ok, q).toBe(false);
  });

  it('corpus property: the lexical guard never accepts a query the AST validator rejects for a forbidden class', () => {
    if (!astAvailable) return;
    const table = fc.constantFrom('__suture_b0', 'orders', 't', 'range(3)', 'generate_series(1,2)', 'unnest([1,2])', "'x.csv'", '"x.csv"',
      "read_csv('x')", 'glob(\'a\')', '__res_0', '__suture_b7', 'other.t', '(SELECT 1 AS a)', 'missing', '"orders"');
    const head = fc.constantFrom('SELECT * FROM', 'SELECT a FROM', 'WITH t AS (SELECT 1 AS a) SELECT * FROM', 'CREATE TABLE z AS SELECT * FROM',
      'INSERT INTO orders SELECT * FROM', 'EXPLAIN SELECT * FROM', 'FROM', 'SELECT 1, (SELECT 2 FROM');
    const join = fc.constantFrom('', ', __suture_b0', ' JOIN orders ON true', ', range(2)', ", 'y.csv'", ' JOIN read_parquet(\'p\') ON true');
    const tail = fc.constantFrom('', ';', '; DROP TABLE orders', ' /* ; */', ' -- ;', ')', ' WHERE 1 = 1', " WHERE 'a;b' = 'c'");
    let compared = 0;
    fc.assert(
      fc.property(head, table, join, tail, (h, t, j, tl) => {
        const sql = `${h} ${t}${j}${tl}`;
        const a = ast(sql);
        if (a.parserError) return; // not a forbidden class: DuckDB itself cannot parse it
        compared++;
        if (validateLexical(sql, ALLOWED).ok) expect(a.ok, `lexical accepted but AST rejected (${a.reason}): ${sql}`).toBe(true);
      }),
      { numRuns: 1000, seed: 5150 },
    );
    expect(compared).toBeGreaterThan(300);
  });
});
