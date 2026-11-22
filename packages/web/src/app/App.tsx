import { useEffect, type ReactNode } from 'react';
import type { AppStore } from './store.ts';
import { useSnapshot } from './useSnapshot.ts';
import { TopBar } from '../chrome/TopBar.tsx';
import { NarrowBanner, ReplayPrompt, Toasts, TrustBanner } from '../chrome/Banners.tsx';
import { DropOverlay } from '../chrome/DropOverlay.tsx';
import { FormulaBar } from '../grid/FormulaBar.tsx';
import { Grid } from '../grid/Grid.tsx';
import { SheetTabs } from '../grid/SheetTabs.tsx';
import { Drawer } from '../inspector/Drawer.tsx';
import { LineageStrip } from '../xray/LineageStrip.tsx';
import { RightPanel } from './RightPanel.tsx';

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

/**
 * Suture application shell (Spec 04 §1): command bar, banners, formula bar, fracture lineage strip, virtualized grid
 * with the X-Ray overlay, sheet tabs, table drawer, and the Exorcist Audit Studio.
 */
export function App({ store }: { readonly store: AppStore }): ReactNode {
  const snap = useSnapshot(store);

  // The open workbook's full title lives in the browser tab (and the picker's tooltip), not in the command bar.
  useEffect(() => {
    document.title = snap.title === '' ? 'Suture — X-Ray Studio' : `${snap.title} — Suture X-Ray Studio`;
  }, [snap.title]);

  // X-Ray hotkey: Alt+X (Option+X) anywhere; bare X only when focus is outside the grid and outside text inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyX' || e.ctrlKey || e.metaKey) return;
      if (e.altKey) {
        e.preventDefault();
        store.toggleXRay();
        return;
      }
      if (e.shiftKey || isTextTarget(e.target)) return;
      if (e.target instanceof HTMLElement && e.target.closest('[role="grid"]') !== null) return;
      e.preventDefault();
      store.toggleXRay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-obsidian text-ink" data-testid="app" data-workbook={snap.workbook}>
      <TopBar snap={snap} store={store} />
      <NarrowBanner />
      <TrustBanner snap={snap} store={store} />
      <ReplayPrompt snap={snap} store={store} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="flex min-h-[50vh] min-w-0 flex-1 flex-col md:min-h-0">
          <FormulaBar snap={snap} store={store} />
          <LineageStrip snap={snap} store={store} />
          <Grid snap={snap} store={store} />
          <SheetTabs snap={snap} store={store} />
          <Drawer snap={snap} store={store} />
        </main>
        <RightPanel snap={snap} store={store} />
      </div>
      <DropOverlay store={store} />
      <Toasts snap={snap} store={store} />
    </div>
  );
}
