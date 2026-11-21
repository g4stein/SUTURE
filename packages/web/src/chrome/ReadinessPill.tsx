import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSnapshot, AppStore } from '../app/store.ts';
import { ENGINE_NAME, formatMs, pillAccessibleName, pillText } from '../app/format.ts';
import type { EngineName, EngineStatus } from '@suture/runtime/bridge';

const ENGINE_TEXT: Readonly<Record<EngineName, string>> = { duckdb: 'text-engine-sql', pyodide: 'text-engine-py' };

function Dot({ s }: { readonly s: EngineStatus }): ReactNode {
  const cls = s.state === 'ready' ? 'bg-engine-formula' : s.state === 'failed' ? 'bg-fracture' : s.state === 'degraded' ? 'bg-engine-py' : s.state === 'loading' ? 'bg-ink-muted suture-pulse' : 'bg-slate-line';
  return <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}

function Row({ label, children, testid }: { readonly label: string; readonly children: ReactNode; readonly testid?: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-right text-ink" data-testid={testid}>{children}</dd>
    </div>
  );
}

/**
 * Spec 04 §4 — the honest five-state readiness pill: `Grid: Ready | DuckDB: … | Python/NumPy: …`, with a telemetry
 * popover (isolation, validator, cold boot per engine, first and warm evaluation, dataset and table row counts).
 */
export function ReadinessPill({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => { if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const t = snap.telemetry;
  const engines: ReadonlyArray<EngineStatus> = [snap.engines.duckdb, snap.engines.pyodide];
  const coi = snap.isolation.crossOriginIsolated;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button" data-testid="readiness-pill" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}
        aria-label={`Engine readiness: Grid: ${snap.gridReady ? 'Ready' : 'Loading'}; ${engines.map(pillAccessibleName).join('; ')}`}
        className="flex items-center gap-2 rounded-md border border-slate-line bg-slate-surface px-2.5 py-1 font-mono text-[11px] leading-5 hover:border-ink-muted"
      >
        <span data-testid="pill-grid" data-state={snap.gridReady ? 'ready' : 'loading'} className="flex items-center gap-1.5 text-engine-formula">
          <Dot s={{ engine: 'duckdb', state: snap.gridReady ? 'ready' : 'loading', progress: null, reason: null, crashCount: 0 }} />Grid: {snap.gridReady ? 'Ready' : 'Loading'}
        </span>
        {engines.map((s) => (
          <span key={s.engine} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-slate-line">|</span>
            <span data-testid={`pill-${s.engine}`} data-state={s.state} title={s.reason ?? undefined} className={`flex items-center gap-1.5 whitespace-nowrap ${ENGINE_TEXT[s.engine]}`}>
              <Dot s={s} />{pillText(s)}
            </span>
          </span>
        ))}
      </button>
      {open && (
        <div role="dialog" aria-label="Engine telemetry" data-testid="telemetry-popover" className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-slate-line bg-slate-raised p-3 font-mono text-[11px] shadow-2xl">
          <dl>
            <Row label="crossOriginIsolated" testid="tm-coi">{String(coi)}</Row>
            <Row label="SQL validator" testid="tm-validator">{t.validator ?? '—'}</Row>
            <Row label="cold boot DuckDB" testid="tm-duckdb-ms">{formatMs(t.duckdbInitMs)}</Row>
            <Row label="cold boot Pyodide" testid="tm-pyodide-ms">{formatMs(t.pyodideInitMs)}</Row>
            <Row label="first eval (incl. boot)" testid="tm-first-eval-ms">{formatMs(snap.evals.firstEvalMs)}</Row>
            <Row label="warm DAG eval" testid="tm-warm-eval-ms">{formatMs(snap.evals.warmEvalMs)}</Row>
            <Row label="DuckDB">{t.duckdbVersion === null ? '—' : `${t.duckdbVersion} (${t.duckdbBundle ?? '?'})`}</Row>
            <Row label="Pyodide / NumPy">{t.pyodideVersion === null ? '—' : `${t.pyodideVersion} / ${t.numpyVersion ?? '?'}`}</Row>
            <Row label="respawns">{`DuckDB ${t.respawns.duckdb} · Python ${t.respawns.pyodide}`}</Row>
          </dl>
          {!coi && (
            <p data-testid="tm-degraded-note" className="mt-2 border-t border-slate-line pt-2 leading-relaxed text-engine-py">
              This page is not cross-origin isolated, so SharedArrayBuffer is unavailable. Long-running SQL and Python cannot be interrupted in place:
              a timeout restarts the engine instead. Browsers that do not support COEP <span className="text-ink">credentialless</span> stay in this mode.
            </p>
          )}
          {engines.filter((s) => s.reason !== null || s.state === 'failed').map((s) => (
            <div key={s.engine} className="mt-2 border-t border-slate-line pt-2">
              <div className={ENGINE_TEXT[s.engine]}>{ENGINE_NAME[s.engine]}: {s.reason ?? 'failed'}{s.crashCount > 0 ? ` (crashes: ${s.crashCount})` : ''}</div>
              {s.state === 'failed' && (
                <button type="button" data-testid={`retry-${s.engine}`} onClick={() => void store.retryEngine(s.engine)} className="mt-1 rounded border border-slate-line px-2 py-0.5 text-ink hover:border-ink-muted">
                  Retry {ENGINE_NAME[s.engine]}
                </button>
              )}
            </div>
          ))}
          <div className="mt-2 border-t border-slate-line pt-2">
            <div className="mb-1 text-ink-muted">Datasets and large tables</div>
            {snap.datasets.length === 0 && snap.largeTables.length === 0 && <div className="text-ink-muted">none yet</div>}
            <ul className="space-y-0.5">
              {snap.datasets.map((d) => (
                <li key={d.meta.name} data-testid="tm-dataset" className="flex justify-between gap-3"><span className="truncate text-engine-sql">{d.meta.name}</span><span className="tabular">{d.meta.rowCount.toLocaleString('en-US')} rows</span></li>
              ))}
              {snap.largeTables.map((l) => (
                <li key={l.key} data-testid="tm-table" className="flex justify-between gap-3"><span className="truncate">{l.key}</span><span className="tabular">{l.rowCount.toLocaleString('en-US')} rows</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
