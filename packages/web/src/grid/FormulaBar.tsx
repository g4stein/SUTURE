import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSnapshot, AppStore } from '../app/store.ts';
import { CHIP_LABEL } from './cellDisplay.ts';
import { ENGINE_BORDER, ENGINE_TEXT } from './CellView.tsx';

const isEngineSource = (s: string): boolean => /^=\s*(SQL|PY)\(/i.test(s);

/**
 * Spec 04 Req 2 — name box + source editor. `=SQL(` / `=PY(` drafts expand to a monospace multi-line editor (up to 12
 * visible lines) where Shift+Enter inserts a newline; Enter commits and Escape discards.
 */
export function FormulaBar({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const [name, setName] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const key = snap.selection;
  const draft = snap.draft !== null && snap.draft.key.toUpperCase() === key.toUpperCase() ? snap.draft : null;
  const raw = store.source(key)?.raw ?? '';
  const text = draft?.text ?? raw;
  // Req 2.4: the multi-line editor opens WHILE an =SQL( / =PY( draft is being edited; a selected cell shows one line.
  const multi = draft !== null && isEngineSource(text);
  const lines = Math.min(12, Math.max(multi ? 3 : 1, text.split('\n').length));
  const d = store.dialect(key);
  const chip = d === null || d === 'literal' ? null : d;

  useEffect(() => { if (!nameFocused) setName(key); }, [key, nameFocused]);
  useEffect(() => {
    if (snap.draft?.where === 'bar' && document.activeElement !== area.current) area.current?.focus();
  }, [snap.draft]);

  const gridFocus = (): void => document.querySelector<HTMLElement>('[data-testid="grid"]')?.focus({ preventScroll: true });

  return (
    <div className="flex items-start gap-2 border-b border-slate-line bg-slate-surface px-3 py-1.5">
      <input
        data-testid="name-box" aria-label="Name box: go to a cell or defined name" value={name} spellCheck={false}
        onFocus={(e) => { setNameFocused(true); e.target.select(); }} onBlur={() => setNameFocused(false)}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const err = store.goTo(name);
            if (err !== null) store.toast('error', err);
            else { setNameFocused(false); gridFocus(); }
          } else if (e.key === 'Escape') { setName(key); gridFocus(); }
        }}
        className="h-7 w-40 shrink-0 rounded-md border border-slate-line bg-obsidian px-2 font-mono text-xs text-ink focus:border-engine-formula focus:outline-none"
      />
      <span className={`mt-1 shrink-0 rounded-sm border px-1 font-mono text-[10px] font-semibold leading-4 ${chip === null ? 'border-slate-line text-ink-muted' : `${ENGINE_BORDER[chip]} ${ENGINE_TEXT[chip]}`}`} aria-hidden="true">
        {chip === null ? 'fx' : CHIP_LABEL[chip]}
      </span>
      <textarea
        ref={area} data-testid="formula-input" aria-label={`Source of ${key}`} value={text} rows={lines} spellCheck={false} wrap={multi ? 'soft' : 'off'}
        onFocus={() => store.beginEdit(key, null, 'bar')}
        onChange={(e) => { if (draft === null) store.beginEdit(key, e.target.value, 'bar'); else store.updateDraft(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.shiftKey && multi)) { e.preventDefault(); void store.commitDraft(null); gridFocus(); }
          else if (e.key === 'Escape') { e.preventDefault(); store.cancelDraft(); gridFocus(); }
        }}
        className={`min-w-0 flex-1 resize-none rounded-md border bg-obsidian px-2 py-1 font-mono text-xs leading-5 text-ink focus:outline-none ${multi ? 'border-slate-line focus:border-engine-sql' : 'border-slate-line focus:border-engine-formula'} ${lines === 1 ? 'h-7 overflow-hidden whitespace-nowrap' : ''}`}
      />
    </div>
  );
}
