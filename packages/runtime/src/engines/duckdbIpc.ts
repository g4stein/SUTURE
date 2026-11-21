import type { DuckDBConnection } from 'duckdb-wasm-blocking';
import type { ScalarValue } from '@suture/core';

const EOS = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);

/**
 * Runs a prepared statement and returns DuckDB's own Arrow IPC stream bytes (schema message + record batches + EOS),
 * read chunk by chunk through the low-level streaming API. No Arrow objects are re-encoded, so there is no copy beyond
 * the WASM-heap → JS read, and no apache-arrow class-identity hazard. `shouldCancel` is checked before every chunk.
 */
export function queryIPC(conn: DuckDBConnection, sql: string, params: ReadonlyArray<ScalarValue>, shouldCancel: () => boolean): Uint8Array | 'cancelled' {
  return conn.useUnsafe((b, id) => {
    const stmt = b.createPrepared(id, sql);
    try {
      const chunks: Uint8Array[] = [b.sendPrepared(id, stmt, [...params]).slice()];
      for (;;) {
        if (shouldCancel()) {
          b.cancelPendingQuery(id);
          return 'cancelled';
        }
        const c = b.fetchQueryResults(id);
        if (c === null || c.length === 0) break;
        chunks.push(c.slice());
      }
      chunks.push(EOS);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    } finally {
      b.closePrepared(id, stmt);
    }
  });
}

/** Executes a statement for its side effects (DDL / SET / macros). */
export function execSql(conn: DuckDBConnection, sql: string): void {
  conn.useUnsafe((b, id) => b.runQuery(id, sql));
}
