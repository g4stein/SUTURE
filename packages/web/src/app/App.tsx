import type { ReactNode } from 'react';
import type { AppStore } from './store.ts';
import { useSnapshot } from './useSnapshot.ts';
import { TopBar } from '../chrome/TopBar.tsx';
import { NarrowBanner, ReplayPrompt, Toasts, TrustBanner } from '../chrome/Banners.tsx';

/** Suture application shell (Spec 04 §1): command bar and banners; the grid and studio mount below. */
export function App({ store }: { readonly store: AppStore }): ReactNode {
  const snap = useSnapshot(store);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-obsidian text-ink" data-testid="app" data-workbook={snap.workbook}>
      <TopBar snap={snap} store={store} />
      <NarrowBanner />
      <TrustBanner snap={snap} store={store} />
      <ReplayPrompt snap={snap} store={store} />
      <main className="flex min-h-0 flex-1 flex-col" />
      <Toasts snap={snap} store={store} />
    </div>
  );
}
