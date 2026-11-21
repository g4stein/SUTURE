// DIAG(temp): root-cause instrumentation for the CI-only failure of e2e/hardening.spec.ts (cooperative Python interrupt).
// Active only when the e2e build defines __SUTURE_DIAG__ (vite.e2e.config.ts); a no-op in dist/ and in Node tests.
// Each context (page or worker) keeps its lines in globalThis.__sutureDiagLog so the test can read them back without a
// console listener; console output is also emitted. Removed together with every diag() call once the root cause is fixed.
declare const __SUTURE_DIAG__: boolean | undefined;
const ON = typeof __SUTURE_DIAG__ !== 'undefined' && __SUTURE_DIAG__ === true;
const g = globalThis as { __sutureDiagLog?: string[]; __sutureDiagConsole?: boolean };

/** Epoch milliseconds, comparable across the page and its workers. */
export const nowMs = (): number => performance.timeOrigin + performance.now();

export function diag(event: string, data?: Readonly<Record<string, unknown>>): void {
  if (!ON) return;
  const line = `[diag] ${nowMs().toFixed(1)} ${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`;
  (g.__sutureDiagLog ??= []).push(line);
  if (g.__sutureDiagConsole !== false) console.log(line);
}
