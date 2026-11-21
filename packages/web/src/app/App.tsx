import type { ReactNode } from 'react';
import type { AppStore } from './store.ts';
import { useSnapshot } from './useSnapshot.ts';
import { TopBar } from '../chrome/TopBar.tsx';
import { NarrowBanner, ReplayPrompt, Toasts, TrustBanner } from '../chrome/Banners.tsx';
import { FormulaBar } from '../grid/FormulaBar.tsx';
import { Grid } from '../grid/Grid.tsx';
import { SheetTabs } from '../grid/SheetTabs.tsx';
import { Drawer } from '../inspector/Drawer.tsx';
import { RightPanel } from './RightPanel.tsx';

/** Suture application shell (Spec 04 §1): command bar, banners, formula bar, grid, sheet tabs, drawer, inspector. */
export function App({ store }: { readonly store: AppStore }): ReactNode {
  const snap = useSnapshot(store);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-obsidian text-ink" data-testid="app" data-workbook={snap.workbook}>
      <TopBar snap={snap} store={store} />
      <NarrowBanner />
      <TrustBanner snap={snap} store={store} />
      <ReplayPrompt snap={snap} store={store} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="flex min-h-[50vh] min-w-0 flex-1 flex-col md:min-h-0">
          <FormulaBar snap={snap} store={store} />
          <Grid snap={snap} store={store} />
          <SheetTabs snap={snap} store={store} />
          <Drawer snap={snap} store={store} />
        </main>
        <RightPanel snap={snap} store={store} />
      </div>
      <Toasts snap={snap} store={store} />
    </div>
  );
}
