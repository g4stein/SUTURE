import { createWorkbookEngine, NEVER_CANCELLED, toCellKey, type CellValue } from '@suture/core';
import { EngineHost, type WorkerFactory } from '../../src/workers/engineHost.ts';
import { PyBridge, SqlBridge } from '../../src/workers/bridges.ts';
import { detectIsolation } from '../../src/workers/isolation.ts';
import { DeadlineExceeded, EngineCrashed } from '../../src/workers/portClient.ts';
import type { EngineName } from '../../src/workers/protocol.ts';
import { webClock, yieldControl } from '../../src/engines/hostAdapters.ts';

const workers: WorkerFactory = (kind) => {
  if (kind === 'duckdb') return new Worker(new URL('./duckdb.chaos.worker.ts', import.meta.url), { type: 'module', name: 'chaos-duckdb' });
  if (kind === 'pyodide') return new Worker(new URL('./pyodide.chaos.worker.ts', import.meta.url), { type: 'module', name: 'chaos-pyodide' });
  return new Worker(new URL('../../src/workers/ingest.worker.ts', import.meta.url), { type: 'module', name: 'suture-ingest' });
};
const host = new EngineHost(detectIsolation(), workers);

function show(v: CellValue | 'pending'): string {
  if (v === 'pending') return 'pending';
  if (v === null) return 'null';
  if (typeof v !== 'object') return String(v);
  if (v.kind === 'error') return `${v.code} ${v.message}`;
  return v.kind;
}

/** Evaluates a one-sheet workbook through the real bridges with a short single-request deadline. */
async function cells(raw: Record<string, string>, deadlineMs: number): Promise<Record<string, string>> {
  const deadlines = { single: deadlineMs, batch: deadlineMs };
  const eng = createWorkbookEngine({
    sheets: [{ name: 'T', cells: Object.entries(raw).map(([a1, r]) => ({ key: toCellKey({ sheet: 'T', row: Number(a1.slice(1)) - 1, col: a1.charCodeAt(0) - 65 }), raw: r })) }],
    names: [], datasets: [], seed: 1,
  }, { sql: new SqlBridge(() => host.client('duckdb'), 'interactive', deadlines), py: new PyBridge(() => host.client('pyodide'), 'interactive', deadlines), clock: webClock, yieldControl });
  await eng.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 8 });
  const out: Record<string, string> = {};
  for (const a1 of Object.keys(raw)) out[a1] = show(eng.getValue(toCellKey({ sheet: 'T', row: Number(a1.slice(1)) - 1, col: a1.charCodeAt(0) - 65 })));
  return out;
}

/** Raw PortClient requests with an optional abort, to test AbortSignal handling without the scheduler. */
async function pyJobs(jobs: ReadonlyArray<{ readonly code: string; readonly abortAfterMs: number | null }>): Promise<string[]> {
  const c = await host.client('pyodide');
  return Promise.all(jobs.map(async (j) => {
    const ctl = new AbortController();
    if (j.abortAfterMs !== null) setTimeout(() => ctl.abort(), j.abortAfterMs);
    try {
      const r = await c.request('py.run', { cell: toCellKey({ sheet: 'T', row: 0, col: 0 }), code: j.code, vectorized: false, seed: 1, inputs: [] },
        { priority: 'interactive', deadlineMs: 30_000, signal: ctl.signal, generation: null });
      return r.kind === 'value' ? `value ${show(r.value)}` : r.kind;
    } catch (e) {
      return e instanceof DeadlineExceeded ? 'deadline' : e instanceof EngineCrashed ? `crashed ${e.message}` : `error ${String(e)}`;
    }
  }));
}

async function boot(engine: EngineName): Promise<void> {
  await host.client(engine);
}

const api = {
  cells, pyJobs, boot,
  status: (engine: EngineName) => host.status(engine),
  telemetry: () => host.telemetry(),
  isolated: () => globalThis.crossOriginIsolated === true,
};
(globalThis as unknown as { __suture: typeof api }).__suture = api;
document.getElementById('log')?.append('harness ready');
