import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DuckDBConnection } from '../node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking';

/**
 * Real DuckDB-WASM (same duckdb-eh.wasm the browser loads) through duckdb-wasm's synchronous Node bindings.
 * Used by Node-side tests; the browser path is covered by the Playwright E2E test.
 */
interface NodeBlocking {
  createDuckDB(bundles: { eh: { mainModule: string; mainWorker: string } }, logger: unknown, runtime: unknown): Promise<{
    instantiate(): Promise<unknown>;
    open(cfg: { query?: { castDecimalToDouble?: boolean } }): void;
    connect(): DuckDBConnection;
  }>;
  VoidLogger: new () => unknown;
  NODE_RUNTIME: unknown;
}

const require = createRequire(import.meta.url);

export async function openNodeDuckDB(): Promise<DuckDBConnection> {
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'suture-duckdb-')); // extension cache (INSTALL json)
  const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const duckdb = require(entry) as NodeBlocking;
  const db = await duckdb.createDuckDB({ eh: { mainModule: join(dirname(entry), 'duckdb-eh.wasm'), mainWorker: '' } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.open({ query: { castDecimalToDouble: true } });
  return db.connect();
}

export const MACROS = [
  'CREATE OR REPLACE MACRO suture_m32(x) AS (x::UBIGINT & 4294967295::UBIGINT)',
  'CREATE OR REPLACE MACRO suture_xs(x, s) AS xor(x, x >> s)',
  'CREATE OR REPLACE MACRO suture_mul(x, c) AS ((x::UBIGINT * c::UBIGINT) & 4294967295::UBIGINT)',
  'CREATE OR REPLACE MACRO suture_h32(x) AS suture_xs(suture_mul(suture_xs(suture_mul(suture_xs(suture_m32(x), 16), 2146121005), 15), 2221713035), 16)',
  'CREATE OR REPLACE MACRO suture_u01(i, stream) AS suture_h32(xor(suture_m32(i), suture_h32(suture_m32(stream + 2654435769)))) / 4294967296.0',
];
