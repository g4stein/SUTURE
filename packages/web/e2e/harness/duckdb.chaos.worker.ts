import { createBrowserDuckDb, servePeer } from '../../src/workers/duckdbBrowser.ts';
import { startWorkerRuntime, type JobHandler } from '../../src/workers/workerRuntime.ts';

/**
 * E2E-only fault injector around the REAL DuckDB worker (built by vite.e2e.config.ts, never shipped in dist/).
 *   SELECT 'suture:hang'  → a synchronous busy loop that never yields and never reads the cancel flag
 *   SELECT 'suture:crash' → an uncaught error thrown from the worker's global scope while the job is running
 * Every other request goes to the production handler unchanged.
 */
const duckdb = createBrowserDuckDb();
/**
 * A synchronous loop that never yields. It has an observable effect so minifiers cannot delete it: the bundler removed an
 * empty `for (;;) {}` from the first build of this harness (verified in dist-e2e), which silently disabled the hang test.
 */
function spinForever(): never {
  let n = 0;
  for (;;) {
    n = (n + 1) | 0;
    if (n === 0x7fffffff) (globalThis as unknown as { __sutureSpin?: number }).__sutureSpin = n;
  }
}

const chaos: JobHandler = (job, progress) => {
  const r = job.request;
  if (r.kind === 'duckdb.query' && r.payload.sql.includes("'suture:hang'")) {
    spinForever();
  }
  if (r.kind === 'duckdb.query' && r.payload.sql.includes("'suture:crash'")) {
    setTimeout(() => { throw new Error('chaos: simulated unrecoverable WebAssembly trap'); }, 0);
    return new Promise(() => undefined);
  }
  return duckdb.handle(job, progress);
};
startWorkerRuntime(chaos, servePeer(duckdb));
