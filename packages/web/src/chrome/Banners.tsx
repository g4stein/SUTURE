import { useRef, type ReactNode } from 'react';
import type { AppSnapshot, AppStore } from '../app/store.ts';

/** Spec 04 Req 6.5 — non-blocking trust banner: formulas and SQL keep running; =PY() cells show #PY! until trusted. */
export function TrustBanner({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  if (snap.untrustedPy === 0) return null;
  return (
    <div role="status" data-testid="trust-banner" className="flex flex-wrap items-center gap-3 border-b border-engine-py/40 bg-engine-py/10 px-4 py-2 text-xs text-ink">
      <span className="font-mono font-semibold text-engine-py">PY</span>
      <span className="min-w-0 flex-1">
        This workbook came from a file and contains {snap.untrustedPy} Python cell{snap.untrustedPy === 1 ? '' : 's'}. Python is blocked until you trust it:
        it runs locally in a worker, but that worker can make network requests from this page. Formulas and SQL are already running.
      </span>
      <button type="button" data-testid="trust-python" onClick={() => void store.trustPython()} className="rounded-md border border-engine-py px-2.5 py-1 font-mono text-engine-py hover:bg-engine-py/10">
        Trust and run Python
      </button>
    </div>
  );
}

/** Spec 04 Req 7.3 — a replay for a workbook that is neither built in nor open: ask for its .suture.json. */
export function ReplayPrompt({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const file = useRef<HTMLInputElement>(null);
  const a = snap.replayPrompt;
  if (a === null) return null;
  return (
    <div role="status" data-testid="replay-prompt" className="flex flex-wrap items-center gap-3 border-b border-fracture/40 bg-fracture/10 px-4 py-2 text-xs text-ink">
      <span className="min-w-0 flex-1">
        This replay is for workbook <span className="font-mono text-ink-muted">{a.workbookHash.slice(0, 16)}…</span>, which is not built in. Open its .suture.json to replay it.
      </span>
      <button type="button" onClick={() => file.current?.click()} className="rounded-md border border-fracture px-2.5 py-1 font-mono text-fracture hover:bg-fracture/10">Open .suture.json</button>
      <input ref={file} type="file" accept=".json,.suture.json" className="hidden" data-testid="replay-prompt-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f !== undefined) void store.importFile(f); }} />
      <button type="button" onClick={() => store.dismissReplayPrompt()} className="text-ink-muted hover:text-ink" aria-label="Dismiss">✕</button>
    </div>
  );
}

/** < 768 px: readable note that desktop is optimal; the page itself never overflows horizontally. */
export function NarrowBanner(): ReactNode {
  return (
    <div data-testid="narrow-banner" className="border-b border-slate-line bg-slate-raised px-3 py-1.5 text-[11px] text-ink-muted md:hidden">
      Suture is built for desktop screens. Everything works here, including Exorcise Model; the grid scrolls inside its frame.
    </div>
  );
}

export function Toasts({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[min(26rem,calc(100vw-1.5rem))] flex-col gap-2" aria-live="polite">
      {snap.toasts.map((t) => (
        <div key={t.id} data-testid="toast" data-kind={t.kind} className={`pointer-events-auto flex items-start gap-2 rounded-md border bg-slate-raised px-3 py-2 text-xs shadow-xl ${t.kind === 'error' ? 'border-fracture text-ink' : t.kind === 'success' ? 'border-engine-formula text-ink' : 'border-slate-line text-ink'}`}>
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button type="button" onClick={() => store.dismissToast(t.id)} className="text-ink-muted hover:text-ink" aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}
