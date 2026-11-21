import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppStore } from '../app/store.ts';

/** Full-window drag-and-drop target for .csv / .parquet / .xlsx / .suture.json / replay .json. */
export function DropOverlay({ store }: { readonly store: AppStore }): ReactNode {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent): void => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setActive(true); };
    const over = (e: DragEvent): void => { if (hasFiles(e)) e.preventDefault(); };
    const leave = (e: DragEvent): void => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setActive(false); };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      void store.importFiles([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [store]);
  if (!active) return null;
  return (
    <div data-testid="drop-overlay" className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-obsidian/80">
      <div className="rounded-xl border-2 border-dashed border-engine-sql px-10 py-8 text-center font-mono text-sm text-ink">
        <div className="text-engine-sql">Drop to import</div>
        <div className="mt-1 text-xs text-ink-muted">.csv · .parquet · .xlsx · .suture.json · replay .json — parsed locally, never uploaded</div>
      </div>
    </div>
  );
}
