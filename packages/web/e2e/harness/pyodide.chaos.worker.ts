import { createBrowserPyodide } from '../../src/workers/pyodideBrowser.ts';
import type { JobHandler } from '@suture/runtime/bridge';
import { startWorkerRuntime } from '../../src/workers/workerRuntime.ts';

/**
 * E2E-only fault injector around the REAL Pyodide worker (never shipped in dist/).
 *   code containing __suture_hang__  → a synchronous JS busy loop that never reaches Python's interrupt check
 *   code containing __suture_crash__ → an uncaught error thrown from the worker's global scope while the job is running
 * Real Python (including `while True: pass`, which IS interruptible) goes to the production handler unchanged.
 */
const py = createBrowserPyodide();
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
  const code = r.kind === 'py.run' || r.kind === 'py.runBatch' ? r.payload.code : '';
  if (code.includes('__suture_hang__')) {
    spinForever();
  }
  if (code.includes('__suture_crash__')) {
    setTimeout(() => { throw new Error('chaos: simulated Pyodide fatal error'); }, 0);
    return new Promise(() => undefined);
  }
  return py.handle(job, progress);
};
startWorkerRuntime(chaos, py.attachPeer);
