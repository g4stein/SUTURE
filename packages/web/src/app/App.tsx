import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { isCellError, type CellKey, type CellValue, type EngineId, type ReplayArtifact, type ViolatedAssertion } from '@suture/core';
import { WORKBOOKS, type AppSnapshot, type AppStore, type CellRow, type WorkbookId } from './store.ts';
import { engineLabel, formatScalar, formatValue } from './format.ts';
import type { EngineStatus } from '../workers/protocol.ts';

/**
 * Temporary Phase 3 verification UI (workbook picker, generic cell list, file import). Phase 4 replaces it with the
 * virtualized grid and X-Ray overlay of Spec 04; the store, engines, and workers stay.
 */
const ENGINE_TEXT: Readonly<Record<EngineId, string>> = { sql: 'text-engine-sql', py: 'text-engine-py', formula: 'text-engine-formula' };
const ENGINE_BORDER: Readonly<Record<EngineId, string>> = { sql: 'border-engine-sql', py: 'border-engine-py', formula: 'border-engine-formula' };

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
  const ms = (v: number | null): string => (v === null ? '—' : `${v} ms`);
  const item = (label: string, value: string, testid: string, title?: string): ReactNode => (
    <span className="whitespace-nowrap" title={title}><span className="text-ink-muted">{label}</span> <span className="text-ink" data-testid={testid}>{value}</span></span>
  );
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-line bg-slate-surface px-6 py-2 font-mono text-xs tabular" data-testid="telemetry">
      {item('crossOriginIsolated', String(snap.isolation.crossOriginIsolated), 'tm-coi')}
      {item('SQL validator', t.validator ?? '—', 'tm-validator')}
      {item('cold boot DuckDB', ms(t.duckdbInitMs), 'tm-duckdb-ms', 'worker start → engine ready (WASM download, compile, init)')}
      {item('cold boot Pyodide', ms(t.pyodideInitMs), 'tm-pyodide-ms', 'worker start → Python + NumPy ready')}
      {item('first eval', ms(snap.evals.firstEvalMs), 'tm-first-eval-ms', 'first recalculation of this workbook, including any engine boot it triggered')}
      {item('warm DAG eval', ms(snap.evals.warmEvalMs), 'tm-warm-eval-ms', 'latest recalculation with no engine boot or respawn')}
      {item('respawns', `${t.respawns.duckdb}/${t.respawns.pyodide}`, 'tm-respawns', 'DuckDB / Pyodide worker respawns')}
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

function Row({ r, snap, store, failing }: { readonly r: CellRow; readonly snap: AppSnapshot; readonly store: AppStore; readonly failing: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const isEngine = r.engine !== 'formula' || r.raw.startsWith('=');
  const label = isEngine ? (r.raw.length > 72 ? `${r.raw.slice(0, 72).replaceAll('\n', ' ')}…` : r.raw.replaceAll('\n', ' ')) : '';
  return (
    <div role="row" data-testid={`row-${r.key}`} className={`border-b border-slate-line px-4 py-1.5 last:border-b-0 ${failing ? 'bg-fracture/10' : ''}`}>
      <div className="grid grid-cols-[7rem_1fr_5rem_13rem] items-center gap-2">
        <span className={`font-mono text-sm ${ENGINE_TEXT[r.engine]}`}>{r.a1}</span>
        <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-ink-muted">
          <span className="truncate">{label}</span>
          {r.raw.length > 72 && <button type="button" className="shrink-0 rounded border border-slate-line px-1.5 text-[10px] hover:text-ink" onClick={() => setOpen(!open)}>{open ? 'hide' : 'source'}</button>}
        </span>
        <span className={`w-fit rounded border px-1.5 font-mono text-[10px] uppercase ${ENGINE_TEXT[r.engine]} ${ENGINE_BORDER[r.engine]}`}>{r.literal ? 'input' : r.engine}</span>
        <span className="text-right" role="gridcell" data-testid={`value-${r.key}`}>
          {r.literal ? (
            <input
              aria-label={r.key}
              data-testid={`input-${r.key}`}
              className="w-40 rounded border border-slate-line bg-obsidian px-2 py-0.5 text-right font-mono text-sm tabular text-ink focus:border-engine-formula focus:outline-none"
              defaultValue={r.raw}
              key={`${r.key}-${snap.generation}`}
              onKeyDown={(e) => { if (e.key === 'Enter') void store.edit(r.key, e.currentTarget.value); }}
              onBlur={(e) => { if (e.currentTarget.value !== r.raw) void store.edit(r.key, e.currentTarget.value); }}
            />
          ) : (
            <ValueCell v={r.value} failing={failing} />
          )}
        </span>
      </div>
      {open && <pre className="mt-2 overflow-x-auto rounded bg-obsidian p-3 font-mono text-xs text-ink-muted">{r.raw}</pre>}
    </div>
  );
}

function Workbook({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const failingCells = new Set(snap.assertions.filter((a) => !a.ok).map((a) => a.cell));
  const sheets = [...new Set(snap.rows.map((r) => r.sheet))];
  const [keyText, setKey] = useState('');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4" data-testid="workbook" data-title={snap.title}>
      {sheets.map((s) => (
        <section key={s} className="overflow-hidden rounded-lg border border-slate-line" role="grid" aria-label={s}>
          <div className="border-b border-slate-line bg-slate-raised px-4 py-1.5 font-mono text-xs uppercase tracking-wide text-ink-muted">{s}</div>
          {snap.rows.filter((r) => r.sheet === s).map((r) => <Row key={r.key} r={r} snap={snap} store={store} failing={failingCells.has(r.key)} />)}
        </section>
      ))}
      <form className="flex flex-wrap items-center gap-2 font-mono text-xs" onSubmit={(e) => { e.preventDefault(); void store.addCell(keyText, raw).then(setError); }}>
        <span className="text-ink-muted">new cell</span>
        <input aria-label="cell reference" data-testid="new-cell-key" placeholder="Data!A1" value={keyText} onChange={(e) => setKey(e.target.value)} className="w-28 rounded border border-slate-line bg-obsidian px-2 py-1 text-ink" />
        <input aria-label="cell source" data-testid="new-cell-raw" placeholder='=SQL("SELECT count(*) FROM my_dataset")' value={raw} onChange={(e) => setRaw(e.target.value)} className="min-w-[28rem] flex-1 rounded border border-slate-line bg-obsidian px-2 py-1 text-ink" />
        <button type="submit" data-testid="new-cell-add" className="rounded border border-engine-formula px-2 py-1 text-engine-formula">Add</button>
        {error !== null && <span className="text-fracture">{error}</span>}
      </form>
    </div>
  );
}

function Assertions({ snap }: { readonly snap: AppSnapshot }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs" data-testid="assertions">
      <span className="text-ink-muted">assertions:</span>
      {snap.assertions.map((a) => (
        <span key={a.id} data-testid={`assert-${a.id}`} data-ok={a.ok} title={a.detail} className={`rounded border px-2 ${a.ok ? 'border-engine-formula text-engine-formula' : 'suture-pulse border-fracture text-fracture'}`}>
          {a.id} <span className="text-ink-muted">{a.cell.slice(a.cell.indexOf('!') + 1)} {a.label}</span> {a.ok ? '✓' : '✗'}
        </span>
      ))}
    </div>
  );
}

function Lineage({ artifact, failing, rows }: { readonly artifact: ReplayArtifact; readonly failing: boolean; readonly rows: ReadonlyArray<CellRow> }): ReactNode {
  const engineOf = (k: CellKey): EngineId => rows.find((r) => r.key === k)?.engine ?? 'formula';
  const cells = artifact.lineagePath.cells;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="lineage" data-failing={failing}>
      {cells.map((c, i) => {
        const engine = engineOf(c);
        const broken = artifact.lineagePath.failingEdge?.to === c;
        return (
          <span key={c} className="flex items-center gap-1">
            {i > 0 && (
              <svg width="40" height="12" aria-hidden="true" className={failing ? 'suture-pulse' : ''}>
                <path d={broken && failing ? 'M2 6 C 10 0, 14 0, 17 6 M23 6 C 26 12, 30 12, 38 6' : 'M2 6 C 14 0, 26 12, 38 6'} fill="none" strokeWidth={failing ? 2 : 1.25}
                  className={failing ? 'stroke-fracture' : engine === 'sql' ? 'stroke-engine-sql' : engine === 'py' ? 'stroke-engine-py' : 'stroke-engine-formula'}
                  strokeDasharray={engine === 'sql' ? '6 4' : engine === 'py' ? '2 4' : undefined} />
              </svg>
            )}
            <span className={`rounded border px-2 py-0.5 font-mono text-xs ${failing ? 'border-fracture text-fracture' : `${ENGINE_BORDER[engine]} ${ENGINE_TEXT[engine]}`}`}>{c}</span>
          </span>
        );
      })}
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
  const failing = snap.applied !== null && snap.assertions.some((a) => !a.ok);
  return (
    <section className="rounded-lg border border-slate-line bg-slate-surface p-4" data-testid="exorcist" aria-label="Exorcist">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="run-exorcist" disabled={busy} onClick={() => void store.runExorcist()}
          className="rounded border border-fracture px-3 py-1.5 font-mono text-sm text-fracture hover:bg-fracture/10 disabled:opacity-50">
          Run Exorcist Proof
        </button>
        {busy && <button type="button" onClick={() => store.stopExorcist()} className="rounded border border-slate-line px-3 py-1.5 font-mono text-sm text-ink-muted">Stop</button>}
        <span className="font-mono text-xs text-ink-muted" data-testid="exorcist-status">
          {x.kind === 'idle' && 'fuzzes the declared inputs through every engine and checks Tier 1 invariants + the assertions above'}
          {x.kind === 'running' && `seed ${x.seed} · ${x.progress?.mode ?? ''} · ${x.progress?.phase ?? 'starting'} · ${x.progress?.runs ?? 0} runs · ${x.progress?.scenarios ?? 0} scenarios · shrink rounds ${x.progress?.shrinkRounds ?? 0}`}
          {x.kind === 'finished' && x.verdict.kind === 'passed' && `passed: ${x.verdict.runs} runs, no counterexample (${x.ms} ms)`}
          {x.kind === 'finished' && x.verdict.kind === 'violated' && `violated after ${x.ms} ms`}
          {x.kind === 'finished' && x.verdict.kind === 'configError' && `configuration error: ${x.verdict.message}`}
          {x.kind === 'finished' && x.verdict.kind === 'stopped' && 'stopped'}
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
            <dd data-testid="failing-inputs">{artifact.failingInputs.map((f) => `${f.cell} = ${formatScalar(f.value)}`).join(', ')}</dd>
            <dt className="text-ink-muted">workbook</dt><dd className="break-all">{artifact.workbookHash}</dd>
          </dl>
          <Lineage artifact={artifact} failing={failing} rows={snap.rows} />
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

function DataPanel({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  return (
    <section className="space-y-2 rounded-lg border border-slate-line bg-slate-surface p-4 font-mono text-xs" data-testid="data-panel" aria-label="Datasets">
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded border border-engine-sql px-3 py-1.5 text-sm text-engine-sql hover:bg-engine-sql/10">
          Import file
          <input type="file" accept=".csv,.parquet,.xlsx" data-testid="import-file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void store.importFile(f); e.target.value = ''; }} />
        </label>
        <span className="text-ink-muted">.csv · .parquet · .xlsx — parsed locally, never uploaded; query them with =SQL() or =PY()</span>
      </div>
      {snap.imports.map((r, i) => (
        <div key={`${r.file}-${i}`} data-testid="import-report" data-ok={r.ok} className={r.ok ? 'text-ink' : 'text-fracture'}>
          {r.file}: {r.message}{r.warnings.length > 0 && <span className="text-ink-muted"> · {r.warnings.join('; ')}</span>}
        </div>
      ))}
      {snap.datasets.map((d) => (
        <div key={d.meta.name} data-testid={`dataset-${d.meta.name}`} className="text-ink-muted">
          <span className="text-engine-sql">{d.meta.name}</span> · {d.meta.format} · {d.meta.rowCount.toLocaleString('en-US')} rows · {d.meta.schema.map((f) => `${f.name}:${f.arrowType}`).join(', ')}
        </div>
      ))}
    </section>
  );
}

export function App({ store }: { readonly store: AppStore }): ReactNode {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div className="min-h-full bg-obsidian text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-line px-6 py-3">
        <div>
          <h1 className="font-mono text-lg tracking-tight">SUTURE <span className="text-ink-muted">· engine verification</span></h1>
          <p className="text-xs text-ink-muted">DuckDB-WASM → Arrow IPC → NumPy (Option C) → spreadsheet-compatible formulas → Exorcist.</p>
        </div>
        <div className="flex items-center gap-3">
          <select aria-label="workbook" data-testid="workbook-picker" value={snap.workbook} onChange={(e) => void store.switchWorkbook(e.target.value as WorkbookId)}
            className="rounded border border-slate-line bg-slate-raised px-2 py-1 font-mono text-xs text-ink">
            {WORKBOOKS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
          <ReadinessPill snap={snap} />
        </div>
      </header>
      <Telemetry snap={snap} />
      <main className="mx-auto max-w-6xl space-y-5 px-6 py-6">
        <h2 className="font-mono text-sm text-ink" data-testid="workbook-title">{snap.title}</h2>
        <Assertions snap={snap} />
        <ExorcistPanel snap={snap} store={store} />
        <DataPanel snap={snap} store={store} />
        <Workbook snap={snap} store={store} />
      </main>
    </div>
  );
}
