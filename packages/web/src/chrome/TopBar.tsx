import { useRef, type ReactNode } from 'react';
import { WORKBOOKS, type AppSnapshot, type AppStore, type WorkbookId } from '../app/store.ts';
import { BrandMark } from './BrandMark.tsx';
import { ReadinessPill } from './ReadinessPill.tsx';

export const IMPORT_ACCEPT = '.csv,.parquet,.xlsx,.suture.json,.json';

/**
 * Spec 04 §1 — command bar: brand, workbook switcher, Import File, X-Ray toggle, Exorcise Model, readiness pill. One row
 * from 1280 px up (Req 11.7); the open workbook's full title is the picker's tooltip and the browser tab title.
 */
export function TopBar({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const file = useRef<HTMLInputElement>(null);
  const running = snap.exorcist.kind === 'running' || snap.exorcist.kind === 'replaying';
  const blocked = snap.untrustedPy > 0;
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-line bg-slate-surface px-3 py-2 md:flex-nowrap md:px-4">
      <BrandMark />
      <div className="mx-1 hidden h-5 w-px bg-slate-line md:block" aria-hidden="true" />
      <label className="flex min-w-0 items-center gap-2">
        <span className="sr-only">Workbook</span>
        <select
          data-testid="workbook-picker" aria-label="Workbook" title={snap.title} value={snap.workbook === 'imported' ? 'imported' : snap.workbook}
          onChange={(e) => { if (e.target.value !== 'imported') void store.switchWorkbook(e.target.value as WorkbookId); }}
          className="max-w-[16rem] truncate rounded-md border border-slate-line bg-obsidian px-2 py-1 font-mono text-xs text-ink hover:border-ink-muted focus:border-engine-formula focus:outline-none"
        >
          {WORKBOOKS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          {snap.workbook === 'imported' && <option value="imported">{snap.title} (imported)</option>}
        </select>
      </label>
      <div className="ml-auto flex flex-wrap items-center gap-2 xl:flex-nowrap">
        <button
          type="button" data-testid="import-button" onClick={() => file.current?.click()}
          className="rounded-md border border-slate-line px-2.5 py-1 font-mono text-xs text-ink hover:border-engine-sql hover:text-engine-sql"
          title="Import .csv, .parquet, .xlsx, .suture.json, or a replay .json (or drop files anywhere)"
        >
          Import File
        </button>
        <input
          ref={file} type="file" multiple accept={IMPORT_ACCEPT} data-testid="import-file" className="hidden"
          onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; void store.importFiles(fs); }}
        />
        <button
          type="button" data-testid="xray-toggle" aria-pressed={snap.xray} onClick={() => store.toggleXRay()}
          title="X-Ray Mode: draw dependency threads between cells (Alt+X)"
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs ${snap.xray ? 'border-engine-sql bg-engine-sql/10 text-engine-sql' : 'border-slate-line text-ink hover:border-ink-muted'}`}
        >
          X-Ray <kbd className="rounded border border-slate-line px-1 text-[10px] text-ink-muted">Alt+X</kbd>
        </button>
        {running ? (
          <button type="button" data-testid="stop-exorcist" onClick={() => store.stopExorcist()} className="rounded-md border border-fracture px-3 py-1 font-mono text-xs font-semibold text-fracture hover:bg-fracture/10">
            Stop
          </button>
        ) : (
          <button
            type="button" data-testid="run-exorcist" onClick={() => void store.runExorcist()} disabled={blocked}
            title={blocked ? 'Trust this workbook\'s Python first' : 'Fuzz the declared inputs through every engine and hunt for a counterexample'}
            className="rounded-md bg-fracture px-3 py-1 font-mono text-xs font-semibold text-obsidian hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Exorcise Model
          </button>
        )}
        <ReadinessPill snap={snap} store={store} />
      </div>
    </header>
  );
}
