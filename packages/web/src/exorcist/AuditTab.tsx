import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ExecutionMode, ReplayArtifact, UniversalInvariantId } from '@suture/core';
import { TIER1_INVARIANTS as TIER1 } from '@suture/runtime/headless';
import type { AppSnapshot, AppStore, ExorcistUi } from '../app/store.ts';
import { formatScalar, formatSummary } from '../app/format.ts';

export const MODE_LABEL: Readonly<Record<ExecutionMode, string>> = { inProcess: 'In-Process fast-check', batched: 'Batched WASM' };

export function statusText(x: ExorcistUi): string {
  switch (x.kind) {
    case 'idle': return 'Ready. Exorcise Model fuzzes the declared inputs through every engine.';
    case 'running': return x.progress === null ? 'starting…' : `${x.progress.phase} · ${x.progress.runs} runs · ${x.progress.scenarios} scenarios · shrink rounds ${x.progress.shrinkRounds}`;
    case 'finished':
      switch (x.verdict.kind) {
        case 'passed': return `passed: ${x.verdict.runs} runs, no counterexample (${x.ms} ms)`;
        case 'violated': return `violated after ${x.ms} ms`;
        case 'configError': return `configuration error: ${x.verdict.message}`;
        case 'stopped': return 'stopped';
      }
      break;
    case 'replaying': return 'replaying artifact…';
    case 'replayed':
      if (x.outcome.kind === 'reproduced') return `replay: reproduced (${x.outcome.exact ? 'exact' : 'direct'})`;
      if (x.outcome.kind === 'notReproduced') return `replay: not reproduced — ${x.outcome.detail}`;
      return 'replay: this artifact belongs to a different workbook';
    case 'error': return x.message;
  }
  return '';
}

function Stat({ label, value, testid, mode }: { readonly label: string; readonly value: string; readonly testid?: string; readonly mode?: string }): ReactNode {
  return (
    <div className="rounded-md border border-slate-line bg-obsidian/40 px-2 py-1">
      <div className="text-[10px] text-ink-muted">{label}</div>
      <div className="tabular font-mono text-[12px] text-ink" data-testid={testid} data-mode={mode}>{value}</div>
    </div>
  );
}

function ActionBar({ snap, store, artifact }: { readonly snap: AppSnapshot; readonly store: AppStore; readonly artifact: ReplayArtifact | null }): ReactNode {
  const replayFile = useRef<HTMLInputElement>(null);
  const x = snap.exorcist;
  const fragment = x.kind === 'finished' && x.verdict.kind === 'violated' ? x.fragment : null;
  // Disabled buttons drop their accent border, fill, and text color, so they read as unavailable, not as muted actions.
  const btn = 'rounded-md border px-2 py-1 font-mono text-[11px] disabled:cursor-not-allowed disabled:border-slate-line disabled:bg-transparent disabled:text-ink-muted disabled:opacity-50 disabled:hover:bg-transparent';
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="action-bar">
      <button type="button" data-testid="apply-counterexample" disabled={artifact === null} onClick={() => void store.applyCounterexample()} className={`${btn} border-fracture bg-fracture/5 text-fracture hover:bg-fracture/15`}>Apply Counterexample</button>
      <button type="button" data-testid="reset-base" disabled={snap.applied === null} onClick={() => void store.resetBaseValues()} className={`${btn} border-slate-line text-ink hover:border-ink-muted`}>Reset Base Values</button>
      <button type="button" data-testid="focus-xray" disabled={artifact === null} onClick={() => store.focusInXRay()} className={`${btn} border-engine-sql/60 text-engine-sql hover:bg-engine-sql/10`}>Focus in X-Ray</button>
      <button type="button" data-testid="copy-replay" disabled={!(x.kind === 'finished' && x.verdict.kind === 'violated')} onClick={() => void store.copyReplayLink()} className={`${btn} border-slate-line text-ink hover:border-ink-muted`}>
        {fragment === null && x.kind === 'finished' && x.verdict.kind === 'violated' ? 'Download Replay JSON' : 'Copy Replay Link'}
      </button>
      {fragment !== null && <a data-testid="replay-link" href={`#${fragment}`} className="sr-only">replay link</a>}
      <button type="button" data-testid="download-replay" disabled={artifact === null} onClick={() => store.downloadReplay()} className={`${btn} border-slate-line text-ink-muted hover:text-ink`}>Download Replay JSON</button>
      <button type="button" data-testid="export-workbook" onClick={() => store.exportWorkbook()} className={`${btn} border-slate-line text-ink-muted hover:text-ink`}>Export workbook (.suture.json)</button>
      <button type="button" data-testid="import-replay-button" onClick={() => replayFile.current?.click()} className={`${btn} border-slate-line text-ink-muted hover:text-ink`}>Import Replay JSON</button>
      <input ref={replayFile} type="file" accept=".json" data-testid="import-replay" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f !== undefined) void store.importFile(f); }} />
    </div>
  );
}

/** Spec 04 §12 — Audit telemetry, Tier 1 + Tier 2 results, the minimal counterexample, and the one-click action bar. */
export function AuditTab({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const x = snap.exorcist;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (x.kind !== 'running') return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [x.kind]);
  const artifact = store.currentArtifact();
  const mode: ExecutionMode | null = x.kind === 'running' ? x.mode : x.kind === 'finished' ? x.mode : artifact?.mode ?? (snap.configCheck.ok ? snap.configCheck.mode : null);
  const elapsed = x.kind === 'running' ? Math.round(now - x.startedAt) : x.kind === 'finished' ? x.ms : null;
  const scenarios = x.kind === 'running' ? (x.progress?.scenarios ?? 0) : x.kind === 'finished' ? x.scenarios : null;
  const shrink = x.kind === 'running' ? (x.progress?.shrinkRounds ?? 0) : x.kind === 'finished' ? x.shrinkRounds : null;
  const va = artifact?.violatedAssertion ?? null;

  const t1 = (id: UniversalInvariantId): string => {
    if (x.kind === 'running') return 'checking';
    if (x.kind === 'finished' && (x.verdict.kind === 'passed' || x.verdict.kind === 'violated')) {
      if (va !== null && va.tier === 1) return va.invariant === id ? 'violated' : 'held';
      return 'held';
    }
    return '—';
  };
  const t2 = (id: string): string => {
    if (x.kind === 'running') return 'checking';
    if (x.kind === 'finished' && x.verdict.kind === 'passed') return 'held';
    if (va !== null && va.tier === 2) return va.assertion.id === id ? 'violated' : 'not reached';
    if (va !== null) return 'not reached';
    return '—';
  };
  const tone = (s: string): string => (s === 'violated' ? 'text-fracture' : s === 'held' ? 'text-engine-formula' : 'text-ink-muted');

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-start gap-2">
        <span data-testid="exorcist-status" className={`min-w-0 flex-1 font-mono text-[11px] ${x.kind === 'error' || (x.kind === 'finished' && x.verdict.kind === 'violated') ? 'text-fracture' : 'text-ink'}`}>{statusText(x)}</span>
        {snap.exorcistStale && <span data-testid="verdict-stale" className="rounded border border-engine-py px-1.5 font-mono text-[10px] text-engine-py" title="The workbook changed after this session started">stale</span>}
      </div>
      {x.kind === 'replayed' && x.outcome.kind === 'reproduced' && snap.applied === null && (
        // A replay recomputes the counterexample off-grid (the X-Ray callouts show its values); the grid keeps base values.
        <p data-testid="replay-hint" className="font-mono text-[11px] text-ink-muted">The grid shows base values. Apply Counterexample loads the failing inputs.</p>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label="execution mode" value={mode === null ? '—' : MODE_LABEL[mode]} testid="verdict-mode" mode={mode ?? ''} />
        <Stat label="seed" value={x.kind === 'running' || x.kind === 'finished' ? String(x.seed) : artifact !== null ? String(artifact.seed) : '—'} />
        <Stat label="scenarios evaluated" value={scenarios === null ? '—' : scenarios.toLocaleString('en-US')} testid="audit-scenarios" />
        <Stat label="shrink rounds" value={shrink === null ? '—' : String(shrink)} testid="audit-shrink" />
        <Stat label="elapsed" value={elapsed === null ? '—' : `${elapsed.toLocaleString('en-US')} ms`} testid="audit-elapsed" />
        <Stat label="runs" value={x.kind === 'running' ? String(x.progress?.runs ?? 0) : x.kind === 'finished' ? x.runs.toLocaleString('en-US') : '—'} testid="audit-runs" />
      </div>

      {artifact !== null && va !== null && (
        <div data-testid="verdict" className="space-y-2 rounded-md border border-fracture/60 bg-fracture/5 p-2">
          <div data-testid="violated-assertion" className="font-mono text-[12px] font-semibold text-fracture">{va.tier === 2 ? `${va.assertion.id}: ${va.detail}` : `${va.invariant}: ${va.detail}`}</div>
          {va.tier === 2 && (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px]">
              <dt className="text-ink-muted">violated cell</dt><dd className="text-ink">{va.assertion.cell}</dd>
              <dt className="text-ink-muted">observed</dt><dd data-testid="verdict-observed" className="tabular text-fracture">{formatSummary(va.observed)}</dd>
            </dl>
          )}
          <div>
            <div className="text-[10px] text-ink-muted">minimal failing inputs (shrunk)</div>
            <div data-testid="failing-inputs" className="tabular break-words font-mono text-[11px] text-ink">{artifact.failingInputs.map((f) => `${f.cell} = ${formatScalar(f.value)}`).join(', ')}</div>
          </div>
          <div className="break-all font-mono text-[10px] text-ink-muted">seed / path <span data-testid="verdict-seed">{artifact.seed} / {artifact.path}</span></div>
          <ActionBar snap={snap} store={store} artifact={artifact} />
        </div>
      )}
      {artifact === null && <ActionBar snap={snap} store={store} artifact={null} />}

      <section>
        <h2 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-ink-muted">Tier 1 · universal invariants</h2>
        <ul className="space-y-0.5">
          {TIER1.map((i) => {
            const s = t1(i.id);
            return (
              <li key={i.id} data-testid={`t1-${i.id}`} data-status={s} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="text-ink">{i.label}</span><span className={tone(s)}>{s}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-ink-muted">Tier 2 · assertions</h2>
        {snap.config.assertions.length === 0 && <div className="text-ink-muted">none declared</div>}
        <ul className="space-y-0.5">
          {snap.assertions.map((a) => {
            const s = t2(a.id);
            return (
              <li key={a.id} data-testid={`t2-${a.id}`} data-status={s} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="min-w-0 truncate"><span className="text-ink">{a.id}</span> <span className="text-ink-muted">{a.cell} {a.label}</span></span>
                <span className={tone(s)}>{s}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
