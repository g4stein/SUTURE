import { expect, test, type Page } from '@playwright/test';
import { HARNESS, HARNESS_NO_ISOLATION } from './urls.ts';
import { watchConsole } from './console.ts';

/**
 * Spec 02 Req 3 + 9 — worker hardening against REAL workers wrapped in the e2e-only fault injector (dist-e2e/ only).
 * Each scenario evaluates a small workbook through the production bridges, so the assertions are on cell values.
 */
type Api = {
  cells(raw: Record<string, string>, deadlineMs: number): Promise<Record<string, string>>;
  pyJobs(jobs: ReadonlyArray<{ code: string; abortAfterMs: number | null }>): Promise<string[]>;
  boot(engine: 'duckdb' | 'pyodide'): Promise<void>;
  telemetry(): { respawns: { duckdb: number; pyodide: number } };
  isolated(): boolean;
};

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('#log')).toHaveText('harness ready');
}

// DIAG(temp): collect `[diag]` lines from the page AND its dedicated workers (worker.on('console'), Playwright ≥ 1.57) and
// print them after every test, pass or fail, so the GitHub Actions log shows each milestone with epoch-ms timestamps.
// Chromium also mirrors worker console messages onto the page, so lines are keyed by text and keep the worker's label.
let diagLines = new Map<string, string>();
test.beforeEach(({ page }) => {
  diagLines = new Map();
  const take = (where: string) => (m: { text(): string }): void => {
    const t = m.text();
    if (t.startsWith('[diag] ') && (where !== 'page' || !diagLines.has(t))) diagLines.set(t, where);
  };
  page.on('console', take('page'));
  page.on('worker', (w) => w.on('console', take(new URL(w.url()).pathname.split('/').pop()?.replace(/-[\w-]{8}\.js$/, '') ?? 'worker')));
});
test.afterEach(async ({}, testInfo) => {
  const body = [...diagLines].map(([t, where]) => {
    const d = /^\[diag\] (\S+) (.*)$/s.exec(t);
    return `${d?.[1] ?? ''} ${where.padEnd(22)} ${d?.[2] ?? t}`;
  }).sort().join('\n');
  console.log(`[diag-dump] ${testInfo.title} (${testInfo.status})\n${body}`);
  await testInfo.attach('diag-timeline.txt', { body, contentType: 'text/plain' });
});

const call = <T>(page: Page, fn: (api: Api, arg: unknown) => Promise<T> | T, arg: unknown = null): Promise<T> =>
  page.evaluate(([f, a]) => (new Function('api', 'arg', `return (${f as string})(api, arg)`) as (api: unknown, arg: unknown) => Promise<T>)((globalThis as unknown as { __suture: unknown }).__suture, a), [fn.toString(), arg] as const);

test.describe('isolated (COOP/COEP): cooperative cancel, 1 s escalation, crash recovery', () => {
  test('(a) a hung DuckDB job past its deadline escalates to terminate + respawn; only that cell is #TIMEOUT!', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page, HARNESS);
    expect(await call(page, (api) => api.isolated())).toBe(true);
    await call(page, (api) => api.boot('duckdb'));
    const t0 = Date.now();
    const out = await call(page, (api) => api.cells({
      A1: '=SQL("SELECT \'suture:hang\'")', // never yields, never reads the cancel flag
      A2: '=SQL("SELECT 41 + 1")', // queued behind A1 on the same worker
      A3: '=A2+1',
      A4: '=SQL("SELECT count(*) FROM range(1000)")',
    }, 1500));
    console.log(`[e2e] hang → escalation in ${Date.now() - t0} ms: ${JSON.stringify(out)}`);
    expect(out['A1']).toMatch(/^#TIMEOUT! deadline of 1500 ms exceeded/);
    expect(out['A2']).toBe('42');
    expect(out['A3']).toBe('43');
    expect(out['A4']).toBe('1000');
    expect((await call(page, (api) => api.telemetry())).respawns.duckdb).toBe(1);
    const after = await call(page, (api) => api.cells({ A1: '=SQL("SELECT 7 * 6")' }, 1500));
    expect(after['A1']).toBe('42');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('(a) Python `while True: pass` is interrupted cooperatively: #TIMEOUT!, the worker survives (no respawn)', async ({ page }) => {
    await open(page, HARNESS);
    await call(page, (api) => api.boot('pyodide'));
    const out = await call(page, (api) => api.cells({ A1: '=PY("while True: pass")', A2: '=PY("6 * 7")' }, 1500));
    expect(out['A1']).toMatch(/^#TIMEOUT!/);
    expect(out['A2']).toBe('42');
    expect((await call(page, (api) => api.telemetry())).respawns.pyodide).toBe(0);
  });

  test('(a) a Python job that never reaches the interrupt check escalates after 1 s and respawns', async ({ page }) => {
    await open(page, HARNESS);
    await call(page, (api) => api.boot('pyodide'));
    const out = await call(page, (api) => api.cells({ A1: '=PY("__suture_hang__ = 1")', A2: '=PY("6 * 7")' }, 1500));
    expect(out['A1']).toMatch(/^#TIMEOUT!/);
    expect(out['A2']).toBe('42');
    expect((await call(page, (api) => api.telemetry())).respawns.pyodide).toBe(1);
  });

  test('(b) an unrecoverable worker crash respawns cleanly: #SQL! / #PY! "engine crashed" on the running cell only', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page, HARNESS);
    await call(page, (api) => Promise.all([api.boot('duckdb'), api.boot('pyodide')]));
    const out = await call(page, (api) => api.cells({
      A1: '=SQL("SELECT \'suture:crash\'")',
      A2: '=SQL("SELECT 40 + 2")',
      B1: '=PY("__suture_crash__ = 1")',
      B2: '=PY("40 + 2")',
      C1: '=A2+B2',
    }, 20_000));
    console.log(`[e2e] crash recovery: ${JSON.stringify(out)}`);
    expect(out['A1']).toMatch(/^#SQL! engine crashed: .*chaos/);
    expect(out['B1']).toMatch(/^#PY! engine crashed: .*chaos/);
    expect(out['A2']).toBe('42');
    expect(out['B2']).toBe('42');
    expect(out['C1']).toBe('84');
    const t = await call(page, (api) => api.telemetry());
    expect(t.respawns).toEqual({ duckdb: 1, pyodide: 1 });
    expect(errors.filter((e: string) => !/chaos: simulated/.test(e)), errors.join('\n')).toEqual([]);
  });

  test('(c) AbortSignal: a queued job resolves "cancelled" without corrupting the queue; a running job is interrupted', async ({ page }) => {
    await open(page, HARNESS);
    await call(page, (api) => api.boot('pyodide'));
    const out = await call(page, (api) => api.pyJobs([
      { code: 'sum(range(30_000_000))', abortAfterMs: null }, // runs ~seconds
      { code: '1 + 1', abortAfterMs: 50 }, // aborted while queued
      { code: '2 + 2', abortAfterMs: null }, // must still run, in order
    ]));
    expect(out).toEqual(['value 449999985000000', 'cancelled', 'value 4']);
    const running = await call(page, (api) => api.pyJobs([{ code: 'while True: pass', abortAfterMs: 300 }, { code: '3 + 3', abortAfterMs: null }]));
    expect(running).toEqual(['cancelled', 'value 6']);
    expect((await call(page, (api) => api.telemetry())).respawns.pyodide).toBe(0);
  });
});

test.describe('not isolated (no COOP/COEP): timeouts terminate and respawn directly', () => {
  test('(a) a hung Python job past its deadline respawns the worker; only that cell is #TIMEOUT!', async ({ page }) => {
    await open(page, HARNESS_NO_ISOLATION);
    expect(await call(page, (api) => api.isolated())).toBe(false);
    await call(page, (api) => api.boot('pyodide'));
    const out = await call(page, (api) => api.cells({ A1: '=PY("while True: pass")', A2: '=PY("6 * 7")', A3: '=A2*2' }, 1500));
    expect(out['A1']).toMatch(/^#TIMEOUT!/);
    expect(out['A2']).toBe('42');
    expect(out['A3']).toBe('84');
    expect((await call(page, (api) => api.telemetry())).respawns.pyodide).toBe(1);
  });
});
