import { useSyncExternalStore } from 'react';
import type { AppSnapshot, AppStore } from './store.ts';

export function useSnapshot(store: AppStore): AppSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
