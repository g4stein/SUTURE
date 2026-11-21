import { Fragment, type ReactNode } from 'react';
import { decodeScalar } from '@suture/core';
import type { AppSnapshot, AppStore } from '../app/store.ts';
import { formatSummary, formatValue } from '../app/format.ts';
import { CHIP_LABEL } from '../grid/cellDisplay.ts';
import { ENGINE_TEXT } from '../grid/CellView.tsx';

const U = (k: string): string => k.toUpperCase();

/**
 * Fracture lineage strip: every step of the failing lineage (input → SQL → Python → formula → violated cell), with
 * the value it takes under the shrunk counterexample. Each step chip jumps to its sheet and selects the cell.
 */
export function LineageStrip({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const f = snap.focus;
  if (f === null) return null;
  const inputs = new Map(f.artifact.failingInputs.map((i) => [U(i.cell), i]));
  const v = f.artifact.violatedAssertion;
  const violated = v.tier === 2 ? U(v.assertion.cell) : v.cell === null ? null : U(v.cell);
  const failing = f.lineage.failingEdge;
  return (
    <nav aria-label="Failing lineage" data-testid="lineage" data-failing="true" className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-fracture/30 bg-fracture/5 px-3 py-1.5">
      <span className="mr-1 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-fracture">Fracture</span>
      {f.lineage.cells.map((k, i) => {
        const prev = i > 0 ? f.lineage.cells[i - 1] : undefined;
        const sheetOf = (x: string): string => x.slice(0, x.lastIndexOf('!'));
        // Consecutive steps on one sheet show the sheet name once, which keeps eight-input lineages readable.
        const label = prev !== undefined && sheetOf(prev).toUpperCase() === sheetOf(k).toUpperCase() ? k.slice(k.lastIndexOf('!') + 1) : k;
        const broken = prev !== undefined && failing !== null && U(failing.from) === U(prev) && U(failing.to) === U(k);
        const d = store.dialect(k);
        const engine = d === 'sql' || d === 'py' ? d : 'formula';
        const inp = inputs.get(U(k));
        const value = U(k) === violated && v.tier === 2 ? formatSummary(v.observed) : inp !== undefined ? formatValue(decodeScalar(inp.value)) : store.describe(f.callouts.get(k));
        return (
          <Fragment key={k}>
            {i > 0 && <span aria-hidden="true" className={`shrink-0 font-mono text-[11px] ${broken ? 'text-fracture' : 'text-fracture/60'}`}>{broken ? '─╳→' : '──→'}</span>}
            <button type="button" data-testid={`lineage-step-${k}`} onClick={() => { store.select(k); store.toggleXRay(true); }}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] hover:bg-slate-raised ${U(k) === violated ? 'border-fracture bg-fracture/15 text-ink' : 'border-fracture/40 text-ink'}`}>
              <span className={`text-[9px] font-semibold ${inp !== undefined ? 'text-fracture' : ENGINE_TEXT[engine]}`}>{inp !== undefined ? 'IN' : CHIP_LABEL[engine]}</span>
              <span title={k}>{label}</span>
              <span className="tabular text-ink-muted">{value}</span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
