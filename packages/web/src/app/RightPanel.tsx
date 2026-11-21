import { useState, type ReactNode } from 'react';
import type { AppSnapshot, AppStore, PanelTab } from './store.ts';
import { CellInspector } from '../inspector/CellInspector.tsx';

const TABS: ReadonlyArray<{ readonly id: PanelTab; readonly label: string }> = [
  { id: 'cell', label: 'Cell' },
];

/** Exorcist Audit Studio (right inspector panel). Below 768 px it becomes a collapsible bottom sheet. */
export function RightPanel({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const [openNarrow, setOpenNarrow] = useState(false);
  return (
    <aside aria-label="Exorcist Audit Studio" data-testid="studio" className={`flex min-h-0 flex-col border-slate-line bg-slate-surface md:w-[25rem] md:shrink-0 md:border-l lg:w-[27rem] ${openNarrow ? 'h-[55vh]' : 'h-auto'} border-t md:h-auto md:border-t-0`}>
      <div role="tablist" aria-label="Studio" className="flex items-stretch border-b border-slate-line bg-slate-raised font-mono text-[11px]">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={snap.panel === t.id} data-testid={`panel-tab-${t.id}`}
            onClick={() => { store.setPanel(t.id); setOpenNarrow(true); }}
            className={`flex-1 border-b-2 px-2 py-2 ${snap.panel === t.id ? 'border-engine-formula text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}>
            {t.label}
          </button>
        ))}
        <button type="button" aria-label={openNarrow ? 'Collapse studio' : 'Expand studio'} onClick={() => setOpenNarrow((o) => !o)} className="px-3 text-ink-muted hover:text-ink md:hidden">{openNarrow ? '▾' : '▴'}</button>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto p-3 ${openNarrow ? 'block' : 'hidden'} md:block`}>
        <CellInspector snap={snap} store={store} />
      </div>
    </aside>
  );
}
