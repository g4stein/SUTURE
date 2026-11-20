import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { isCellError, type CellKey, type CellValue, type EngineId, type ReplayArtifact, type ViolatedAssertion } from '@suture/core';
import type { AppSnapshot, AppStore } from './store.ts';
import { engineLabel, formatScalar, formatValue } from './format.ts';
import { A1_SQL, B1_PY, E1_SQL, k } from '../slice/sliceDocument.ts';
import type { EngineStatus } from '../workers/protocol.ts';

const ENGINE_TEXT: Readonly<Record<EngineId, string>> = { sql: 'text-engine-sql', py: 'text-engine-py', formula: 'text-engine-formula' };
const ENGINE_BORDER: Readonly<Record<EngineId, string>> = { sql: 'border-engine-sql', py: 'border-engine-py', formula: 'border-engine-formula' };

interface RowSpec {
  readonly cell: CellKey;
  readonly label: string;
  readonly engine: EngineId;
  readonly source: string;
  readonly editable: boolean;
}

const ROWS: ReadonlyArray<RowSpec> = [
  { cell: k('C1'), label: 'Starting cash', engine: 'formula', source: 'literal', editable: true },
  { cell: k('C2'), label: 'Churn shock ×', engine: 'formula', source: 'literal', editable: true },
  { cell: k('E1'), label: '10,000 synthesized orders', engine: 'sql', source: E1_SQL, editable: false },
  { cell: k('A1'), label: 'Monthly revenue / cost', engine: 'sql', source: A1_SQL, editable: false },
  { cell: k('B1'), label: 'Projected net burn (OLS, month 13)', engine: 'py', source: B1_PY, editable: false },
  { cell: k('D1'), label: 'Runway (months) = C1 / B1', engine: 'formula', source: '=C1/B1', editable: false },
];

function Pill({ s, name }: { readonly s: EngineStatus; readonly name: string }): ReactNode {
  const label = engineLabel(s);
  const color = s.engine === 'duckdb' ? 'text-engine-sql' : 'text-engine-py';
  const aria = `${name} ${label}${s.reason !== null ? `: ${name}: ${s.reason}` : ''}`;
  return (
    <span className={`${color} ${s.state === 'loading' ? 'animate-pulse' : ''}`} data-testid={`pill-${s.engine}`} data-state={s.state} title={s.reason ?? label} aria-label={aria}>
      {name} {label}
    </span>
  );
}

function ReadinessPill({ snap }: { readonly snap: AppSnapshot }): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-line bg-slate-raised px-3 py-1 font-mono text-xs" data-testid="readiness-pill" role="status">
      <span className="text-ink" data-testid="pill-grid">{snap.gridReady ? 'Grid Ready' : 'Grid Loading'}</span>
      <span className="text-ink-muted">|</span>
      <Pill s={snap.engines.duckdb} name="DuckDB" />
      <span className="text-ink-muted">|</span>
      <Pill s={snap.engines.pyodide} name="Python/NumPy" />
    </div>
  );
}

function Telemetry({ snap }: { readonly snap: AppSnapshot }): ReactNode {
  const t = snap.telemetry;
  const item = (label: string, value: string, testid: string): ReactNode => (
    <span className="whitespace-nowrap"><span className="text-ink-muted">{label}</span> <span className="text-ink" data-testid={testid}>{value}</span></span>
  );
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-line bg-slate-surface px-6 py-2 font-mono text-xs tabular" data-testid="telemetry">
      {item('crossOriginIsolated', String(snap.isolation.crossOriginIsolated), 'tm-coi')}
      {item('SQL validator', t.validator ?? '—', 'tm-validator')}
      {item('DuckDB init', t.duckdbInitMs === null ? '—' : `${t.duckdbInitMs} ms`, 'tm-duckdb-ms')}
      {item('Pyodide init', t.pyodideInitMs === null ? '—' : `${t.pyodideInitMs} ms`, 'tm-pyodide-ms')}
      {item('last DAG eval', snap.lastEvalMs === null ? '—' : `${snap.lastEvalMs} ms`, 'tm-eval-ms')}
      {item('engines', `DuckDB ${t.duckdbVersion ?? '—'} (${t.duckdbBundle ?? '—'}) · Pyodide ${t.pyodideVersion ?? '—'} · NumPy ${t.numpyVersion ?? '—'}`, 'tm-versions')}
    </div>
  );
}

function ValueCell({ v, failing }: { readonly v: CellValue | 'pending' | undefined; readonly failing: boolean }): ReactNode {
  const err = v !== undefined && v !== 'pending' && isCellError(v);
  const cls = err || failing ? 'text-fracture font-semibold' : v === 'pending' ? 'text-ink-muted animate-pulse' : 'text-ink';
  return (
    <span className={`font-mono tabular ${cls}`} title={err ? `${v.code}: ${v.message} (origin ${v.origin})` : undefined}>
      {formatValue(v)}
    </span>
  );
}

function SliceGrid({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const [open, setOpen] = useState<CellKey | null>(null);
  const d1Failing = snap.assertions.some((a) => !a.ok);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-line" role="grid" aria-rowcount={ROWS.length} aria-colcount={4}>
      <div className="grid grid-cols-[6rem_1fr_7rem_12rem] border-b border-slate-line bg-slate-raised px-4 py-2 font-mono text-xs uppercase tracking-wide text-ink-muted" role="row">
        <span>Cell</span><span>Definition</span><span>Engine</span><span className="text-right">Value</span>
      </div>
      {ROWS.map((r) => {
        const a1 = r.cell.slice(r.cell.indexOf('!') + 1);
        const v = snap.values.get(r.cell);
        const failing = r.cell === k('D1') && d1Failing;
        return (
          <div key={r.cell} role="row" data-testid={`row-${a1}`} className={`border-b border-slate-line px-4 py-2 last:border-b-0 ${failing ? 'bg-fracture/10' : ''}`}>
            <div className="grid grid-cols-[6rem_1fr_7rem_12rem] items-center gap-2">
              <span className={`font-mono text-sm ${ENGINE_TEXT[r.engine]}`}>{a1}</span>
              <span className="flex items-center gap-2 text-sm">
                {r.label}
                {!r.editable && r.source !== '' && (
                  <button type="button" className="rounded border border-slate-line px-1.5 font-mono text-[10px] text-ink-muted hover:text-ink" onClick={() => setOpen(open === r.cell ? null : r.cell)}>
                    {open === r.cell ? 'hide' : 'source'}
                  </button>
                )}
              </span>
              <span className={`w-fit rounded border px-1.5 font-mono text-[10px] uppercase ${ENGINE_TEXT[r.engine]} ${ENGINE_BORDER[r.engine]}`}>{r.engine}</span>
              <span className="text-right" role="gridcell" data-testid={`value-${a1}`}>
                {r.editable ? (
                  <input
                    aria-label={r.label}
                    data-testid={`input-${a1}`}
                    className="w-36 rounded border border-slate-line bg-obsidian px-2 py-1 text-right font-mono tabular text-ink focus:border-engine-formula focus:outline-none"
                    defaultValue={snap.raws.get(r.cell) ?? ''}
                    key={`${r.cell}-${snap.generation}-${snap.applied === null ? 'u' : 'a'}`}
                    onKeyDown={(e) => { if (e.key === 'Enter') void store.edit(r.cell, e.currentTarget.value); }}
                    onBlur={(e) => { if (e.currentTarget.value !== snap.raws.get(r.cell)) void store.edit(r.cell, e.currentTarget.value); }}
                  />
                ) : (
                  <ValueCell v={v} failing={failing} />
                )}
              </span>
            </div>
            {open === r.cell && <pre className="mt-2 overflow-x-auto rounded bg-obsidian p-3 font-mono text-xs text-ink-muted">{r.source}</pre>}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-line bg-slate-surface px-4 py-2 font-mono text-xs" data-testid="assertions">
        <span className="text-ink-muted">D1 assertions:</span>
        {snap.assertions.map((a) => (
          <span key={a.id} data-testid={`assert-${a.id}`} data-ok={a.ok} title={a.detail} className={`rounded border px-2 ${a.ok ? 'border-engine-formula text-engine-formula' : 'suture-pulse border-fracture text-fracture'}`}>
            {a.label} {a.ok ? '✓' : '✗'}
          </span>
        ))}
      </div>
    </div>
  );
}

function Lineage({ failing }: { readonly failing: boolean }): ReactNode {
  const node = (id: string, engine: EngineId): ReactNode => (
    <span className={`rounded border px-2 py-0.5 font-mono text-xs ${failing ? 'border-fracture text-fracture' : `${ENGINE_BORDER[engine]} ${ENGINE_TEXT[engine]}`}`}>{id}</span>
  );
  const thread = (engine: EngineId, broken: boolean): ReactNode => (
    <svg width="56" height="12" aria-hidden="true" className={failing ? 'suture-pulse' : ''}>
      <path d={broken ? 'M2 6 C 14 0, 20 0, 24 6 M32 6 C 36 12, 42 12, 54 6' : 'M2 6 C 18 0, 38 12, 54 6'} fill="none" strokeWidth={failing ? 2 : 1.25}
        className={failing ? 'stroke-fracture' : engine === 'sql' ? 'stroke-engine-sql' : engine === 'py' ? 'stroke-engine-py' : 'stroke-engine-formula'}
        strokeDasharray={engine === 'sql' ? '6 4' : engine === 'py' ? '2 4' : undefined} />
    </svg>
  );
  return (
    <div className="flex items-center gap-1" data-testid="lineage" data-failing={failing}>
      {node('C2', 'formula')}{thread('sql', false)}{node('A1', 'sql')}{thread('py', false)}{node('B1', 'py')}{thread('formula', failing)}{node('D1', 'formula')}
    </div>
  );
}

function violationText(v: ViolatedAssertion): string {
  return v.tier === 2 ? `${v.assertion.id}: ${v.detail}` : `${v.invariant}: ${v.detail}`;
}

function ExorcistPanel({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const x = snap.exorcist;
  const [copied, setCopied] = useState(false);
  const artifact: ReplayArtifact | null = x.kind === 'finished' && x.verdict.kind === 'violated' ? x.verdict.artifact : x.kind === 'replayed' ? x.artifact : null;
  const busy = x.kind === 'running' || x.kind === 'replaying';
  return (
    <section className="rounded-lg border border-slate-line bg-slate-surface p-4" data-testid="exorcist" aria-label="Exorcist">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="run-exorcist" disabled={busy} onClick={() => void store.runExorcist()}
          className="rounded border border-fracture px-3 py-1.5 font-mono text-sm text-fracture hover:bg-fracture/10 disabled:opacity-50">
          Run Exorcist Proof
        </button>
        {busy && <button type="button" onClick={() => store.stopExorcist()} className="rounded border border-slate-line px-3 py-1.5 font-mono text-sm text-ink-muted">Stop</button>}
        <span className="font-mono text-xs text-ink-muted" data-testid="exorcist-status">
          {x.kind === 'idle' && 'fuzzes C1 ∈ [10k, 2M] and C2 ∈ [0, 3] through DuckDB → NumPy → formula (batched mode)'}
          {x.kind === 'running' && `seed ${x.seed} · ${x.progress?.phase ?? 'starting'} · ${x.progress?.runs ?? 0} runs · ${x.progress?.scenarios ?? 0} scenarios · shrink rounds ${x.progress?.shrinkRounds ?? 0}`}
          {x.kind === 'finished' && x.verdict.kind === 'passed' && `passed: ${x.verdict.runs} runs, no counterexample (${x.ms} ms)`}
          {x.kind === 'finished' && x.verdict.kind === 'violated' && `violated after ${x.ms} ms`}
          {x.kind === 'finished' && (x.verdict.kind === 'stopped' || x.verdict.kind === 'configError') && x.verdict.kind}
          {x.kind === 'replaying' && 'replaying artifact…'}
          {x.kind === 'replayed' && `replay: ${x.outcome.kind}${x.outcome.kind === 'reproduced' ? (x.outcome.exact ? ' (exact)' : ' (direct)') : ''}`}
          {x.kind === 'error' && <span className="text-fracture">{x.message}</span>}
        </span>
      </div>
      {artifact !== null && (
        <div className="mt-4 space-y-3" data-testid="verdict">
          <div className="font-mono text-sm text-fracture" data-testid="violated-assertion">{violationText(artifact.violatedAssertion)}</div>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-ink-muted">mode</dt><dd data-testid="verdict-mode">{artifact.mode}</dd>
            <dt className="text-ink-muted">seed / path</dt><dd className="break-all" data-testid="verdict-seed">{artifact.seed} / {artifact.path}</dd>
            <dt className="text-ink-muted">shrunk inputs</dt>
            <dd data-testid="failing-inputs">{artifact.failingInputs.map((f) => `${f.cell.slice(f.cell.indexOf('!') + 1)} = ${formatScalar(f.value)}`).join(', ')}</dd>
            <dt className="text-ink-muted">lineage</dt><dd>{artifact.lineagePath.cells.map((c) => c.slice(c.indexOf('!') + 1)).join(' → ')}</dd>
            <dt className="text-ink-muted">workbook</dt><dd className="break-all">{artifact.workbookHash}</dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="apply-counterexample" onClick={() => void store.applyCounterexample(artifact)}
              className="rounded border border-fracture bg-fracture/10 px-3 py-1.5 font-mono text-sm text-fracture hover:bg-fracture/20">
              Apply Counterexample
            </button>
            {x.kind === 'finished' && x.fragment !== null && (
              <button type="button" data-testid="copy-replay" className="rounded border border-slate-line px-3 py-1.5 font-mono text-sm text-ink-muted hover:text-ink"
                onClick={() => {
                  const url = `${location.origin}${location.pathname}#${x.fragment ?? ''}`;
                  void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false));
                }}>
                {copied ? 'Replay link copied' : 'Copy replay link'}
              </button>
            )}
            {x.kind === 'finished' && x.fragment !== null && <a data-testid="replay-link" className="self-center font-mono text-xs text-ink-muted underline" href={`#${x.fragment}`}>replay link</a>}
          </div>
        </div>
      )}
    </section>
  );
}

export function App({ store }: { readonly store: AppStore }): ReactNode {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const failing = snap.assertions.some((a) => !a.ok) || (() => { const v = snap.values.get(k('D1')); return v !== undefined && v !== 'pending' && isCellError(v); })();
  return (
    <div className="min-h-full bg-obsidian text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-line px-6 py-3">
        <div>
          <h1 className="font-mono text-lg tracking-tight">SUTURE <span className="text-ink-muted">· vertical slice</span></h1>
          <p className="text-xs text-ink-muted">One cross-engine chain: DuckDB-WASM → Arrow IPC → NumPy (Option C) → spreadsheet-compatible formula → Exorcist.</p>
        </div>
        <ReadinessPill snap={snap} />
      </header>
      <Telemetry snap={snap} />
      <main className="mx-auto max-w-5xl space-y-5 px-6 py-6">
        <Lineage failing={failing && snap.applied !== null} />
        <SliceGrid snap={snap} store={store} />
        <ExorcistPanel snap={snap} store={store} />
      </main>
    </div>
  );
}
