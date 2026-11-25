import type { ReactNode } from 'react';
import type { AppSnapshot, AppStore } from '../app/store.ts';

/** Multi-sheet tab bar (+ add sheet, + datasets drawer toggle). */
export function SheetTabs({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const datasetsOpen = snap.drawer?.kind === 'datasets' || snap.drawer?.kind === 'dataset';
  return (
    <div className="flex min-w-0 items-stretch gap-px overflow-x-auto border-t border-slate-line bg-slate-raised font-mono text-[11px]">
      {/* Only the sheet tabs live in the tablist; the add and datasets buttons sit beside it (WAI-ARIA tabs pattern). */}
      <div role="tablist" aria-label="Sheets" className="flex min-w-0 items-stretch gap-px">
        {snap.sheets.map((s) => {
          const active = s === snap.activeSheet;
          return (
            <button key={s} type="button" role="tab" aria-selected={active} data-testid={`sheet-tab-${s}`} onClick={() => store.setActiveSheet(s)}
              className={`shrink-0 border-t-2 px-3 py-1.5 ${active ? 'border-engine-formula bg-slate-surface text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}>
              {s}
            </button>
          );
        })}
      </div>
      <button type="button" aria-label="Add sheet" data-testid="add-sheet" onClick={() => store.addSheet()} className="shrink-0 px-2.5 text-ink-muted hover:text-ink">+</button>
      <div className="flex-1" />
      <button type="button" data-testid="datasets-toggle" aria-pressed={datasetsOpen} onClick={() => store.openDrawer(datasetsOpen ? null : { kind: 'datasets' })}
        className={`shrink-0 px-3 ${datasetsOpen ? 'text-engine-sql' : 'text-ink-muted hover:text-ink'}`}>
        Datasets ({snap.datasets.length})
      </button>
    </div>
  );
}
