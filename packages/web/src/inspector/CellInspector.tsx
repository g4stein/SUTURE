import type { ReactNode } from 'react';
import type { CellKey, CellValue } from '@suture/core';
import type { AppSnapshot, AppStore } from '../app/store.ts';
import { formatNumber, formatValue } from '../app/format.ts';
import { CHIP_LABEL } from '../grid/cellDisplay.ts';
import { ENGINE_BORDER, ENGINE_TEXT } from '../grid/CellView.tsx';

const DIALECT: Readonly<Record<string, string>> = { literal: 'Literal value', formula: 'Formula (spreadsheet-compatible)', sql: 'SQL · DuckDB-WASM', py: 'Python · Pyodide + NumPy' };

function Links({ keys, store, empty }: { readonly keys: ReadonlyArray<CellKey>; readonly store: AppStore; readonly empty: string }): ReactNode {
  if (keys.length === 0) return <div className="text-ink-muted">{empty}</div>;
  const shown = keys.slice(0, 40);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((k) => (
        <button key={k} type="button" onClick={() => store.select(k)} className="rounded border border-slate-line px-1.5 font-mono text-[11px] text-ink hover:border-ink-muted">{k}</button>
      ))}
      {keys.length > shown.length && <span className="text-ink-muted">+{keys.length - shown.length} more</span>}
    </div>
  );
}

function ValueView({ v, k, store }: { readonly v: CellValue | 'pending'; readonly k: CellKey; readonly store: AppStore }): ReactNode {
  if (v === 'pending') return <div className="suture-pulse text-ink-muted">pending — waiting for the engine</div>;
  if (v === null || typeof v !== 'object') return <div data-testid="inspector-value" className="tabular break-all font-mono text-sm text-ink">{formatValue(v) || '(blank)'}</div>;
  if (v.kind === 'error') {
    return (
      <div data-testid="inspector-error" className="space-y-1 rounded-md border border-fracture/50 bg-fracture/5 p-2">
        <div className="font-mono text-sm font-semibold text-fracture">{v.code}</div>
        <div className="whitespace-pre-wrap break-words text-xs text-ink">{v.message}</div>
        <div className="text-[11px] text-ink-muted">engine {v.engine}{v.origin !== '' && <> · origin <button type="button" data-testid="error-origin" onClick={() => store.select(v.origin as CellKey)} className="font-mono text-ink underline decoration-dotted">{v.origin}</button></>}</div>
      </div>
    );
  }
  if (v.kind === 'table') {
    return (
      <div className="space-y-2">
        <div className="font-mono text-sm text-engine-sql">table {v.rowCount.toLocaleString('en-US')} × {v.schema.length}</div>
        <div className="flex flex-wrap gap-1">{v.schema.map((f) => <span key={f.name} className="rounded border border-slate-line px-1 font-mono text-[10px] text-ink-muted">{f.name}:<span className="text-ink">{f.arrowType}</span></span>)}</div>
        <button type="button" data-testid="inspector-open-table" onClick={() => store.openDrawer({ kind: 'cell', key: k })} className="rounded-md border border-engine-sql/60 px-2 py-0.5 font-mono text-[11px] text-engine-sql hover:bg-engine-sql/10">Preview first 100 rows</button>
      </div>
    );
  }
  const rows = Math.min(v.rows, 200);
  return (
    <div className="max-h-56 overflow-auto rounded-md border border-slate-line">
      <table className="w-full font-mono text-[11px]">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="border-b border-slate-line/60">
              <td className="px-1.5 text-right text-ink-muted">{r + 1}</td>
              {Array.from({ length: v.cols }, (_, c) => <td key={c} className="tabular px-1.5 text-right text-ink">{formatNumber(v.data[r * v.cols + c] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Spec 04 Req 3 — dialect, engine, source, value (with error origin), precedents/dependents, and attached assertions. */
export function CellInspector({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  void snap.valueVersion;
  const k = snap.selection;
  const src = store.source(k);
  const d = store.dialect(k);
  const v = store.value(k);
  const engine = d === 'sql' || d === 'py' || d === 'formula' ? d : null;
  const attached = snap.assertions.filter((a) => a.cell.toUpperCase() === k.toUpperCase());
  const x = snap.exorcist;
  const verdictStatus = (id: string): string => {
    if (x.kind !== 'finished') return 'not run';
    if (x.verdict.kind === 'passed') return 'held';
    if (x.verdict.kind === 'violated') {
      const va = x.verdict.artifact.violatedAssertion;
      return va.tier === 2 && va.assertion.id === id ? 'violated' : 'not reached';
    }
    return 'not reached';
  };
  return (
    <div data-testid="cell-inspector" className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ink">{k}</span>
        {engine !== null && <span className={`rounded-sm border px-1 font-mono text-[10px] font-semibold ${ENGINE_BORDER[engine]} ${ENGINE_TEXT[engine]}`}>{CHIP_LABEL[engine]}</span>}
        <span className="text-ink-muted">{src === null ? 'empty cell' : DIALECT[d ?? 'literal']}</span>
      </div>
      {src !== null && (
        <pre data-testid="inspector-source" className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-line bg-obsidian p-2 font-mono text-[11px] leading-5 text-ink">{src.raw}</pre>
      )}
      {src !== null && <ValueView v={v} k={k} store={store} />}
      {store.isBlocked(k) && <div className="rounded-md border border-engine-py/50 bg-engine-py/10 p-2 text-engine-py">Python from an imported file: blocked until you trust the workbook.</div>}
      <div>
        <div className="mb-1 text-ink-muted">Precedents</div>
        <Links keys={src === null ? [] : store.precedents(k)} store={store} empty="none" />
      </div>
      <div>
        <div className="mb-1 text-ink-muted">Dependents</div>
        <Links keys={store.dependents(k)} store={store} empty="none" />
      </div>
      {attached.length > 0 && (
        <div>
          <div className="mb-1 text-ink-muted">Assertions on this cell</div>
          <ul className="space-y-1">
            {attached.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 rounded border border-slate-line px-2 py-1">
                <span className="font-mono text-[11px]">{a.id} <span className="text-ink-muted">{a.label}</span></span>
                <span className={`font-mono text-[10px] ${verdictStatus(a.id) === 'violated' ? 'text-fracture' : verdictStatus(a.id) === 'held' ? 'text-engine-formula' : 'text-ink-muted'}`}>{verdictStatus(a.id)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
