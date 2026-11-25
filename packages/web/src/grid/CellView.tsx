import { memo, type ReactNode } from 'react';
import type { EngineId } from '@suture/core';
import { CHIP_LABEL, type CellKind } from './cellDisplay.ts';

export const ENGINE_TEXT: Readonly<Record<EngineId, string>> = { formula: 'text-engine-formula', sql: 'text-engine-sql', py: 'text-engine-py' };
export const ENGINE_BORDER: Readonly<Record<EngineId, string>> = { formula: 'border-engine-formula', sql: 'border-engine-sql', py: 'border-engine-py' };
export const ENGINE_STROKE: Readonly<Record<EngineId, string>> = { formula: 'stroke-engine-formula', sql: 'stroke-engine-sql', py: 'stroke-engine-py' };
export const ENGINE_FILL: Readonly<Record<EngineId, string>> = { formula: 'fill-engine-formula', sql: 'fill-engine-sql', py: 'fill-engine-py' };

export interface CellViewProps {
  readonly cellKey: string;
  readonly col: number;
  readonly x: number;
  readonly w: number;
  readonly kind: CellKind;
  readonly text: string;
  readonly chip: EngineId | null;
  readonly title: string | null;
  readonly raw: string | null;
  readonly selected: boolean;
  readonly dim: boolean;
  readonly lineage: boolean;
}

/** One grid cell. Memoized on primitive props, so scrolling and edits re-render only the cells that change. */
export const CellView = memo(function CellView(p: CellViewProps): ReactNode {
  const align = p.kind === 'number' || p.kind === 'pending' ? 'justify-end' : p.kind === 'bool' || p.kind === 'error' ? 'justify-center' : 'justify-start';
  return (
    <div
      role="gridcell" aria-colindex={p.col + 1} aria-selected={p.selected} data-key={p.cellKey} data-testid={p.kind === 'empty' && !p.selected ? undefined : `cell-${p.cellKey}`}
      data-kind={p.kind} data-dim={p.dim ? 'true' : undefined}
      title={p.title ?? undefined}
      className={`absolute top-0 flex h-6 items-center gap-1 overflow-hidden border-b border-r border-slate-line/70 px-1.5 font-mono text-[12px] leading-6 ${align} ${p.dim ? 'opacity-[0.55]' : ''} ${p.lineage ? 'bg-fracture/10' : ''} ${p.selected ? 'z-[2] outline outline-2 -outline-offset-2 outline-engine-formula' : ''}`}
      style={{ left: p.x, width: p.w }}
    >
      {p.chip !== null && (
        <span className={`shrink-0 rounded-sm border px-0.5 text-[9px] font-semibold leading-[12px] ${ENGINE_TEXT[p.chip]} ${ENGINE_BORDER[p.chip]} border-opacity-60`}>{CHIP_LABEL[p.chip]}</span>
      )}
      {p.kind === 'error' ? (
        <span data-testid={`value-${p.cellKey}`} className="rounded-sm border border-fracture/70 bg-fracture/10 px-1 text-[11px] font-semibold leading-[16px] text-fracture">{p.text}</span>
      ) : p.kind === 'table' ? (
        <button type="button" data-inspect={p.cellKey} data-testid={`inspect-${p.cellKey}`} className="min-w-0 truncate rounded-sm border border-engine-sql/50 px-1 text-[11px] leading-[16px] text-engine-sql hover:bg-engine-sql/10">
          <span data-testid={`value-${p.cellKey}`} className="tabular">{p.text}</span> — inspect
        </button>
      ) : p.kind === 'matrix' ? (
        <button type="button" data-inspect={p.cellKey} className="min-w-0 truncate rounded-sm border border-engine-py/50 px-1 text-[11px] leading-[16px] text-engine-py hover:bg-engine-py/10">
          <span data-testid={`value-${p.cellKey}`}>{p.text}</span>
        </button>
      ) : (
        <span data-testid={p.kind === 'empty' ? undefined : `value-${p.cellKey}`} data-raw={p.raw ?? undefined} className={`min-w-0 truncate ${p.kind === 'number' ? 'tabular text-ink' : p.kind === 'pending' ? 'suture-pulse text-ink-muted' : 'text-ink'}`}>{p.text}</span>
      )}
    </div>
  );
});
