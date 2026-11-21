import { memo, type ReactNode } from 'react';
import type { EngineId } from '@suture/core';
import { ENGINE_FILL, ENGINE_STROKE } from '../grid/CellView.tsx';
import type { XRayFrame, XRayThread } from './edges.ts';

/** Steering §2: color is never the only signal — SQL dashed, Python dotted, Formula solid. */
export const DASH: Readonly<Record<EngineId, string | undefined>> = { sql: '6 4', py: '2 4', formula: undefined };
const ENGINES: ReadonlyArray<EngineId> = ['formula', 'sql', 'py'];

function Arrow({ id, cls }: { readonly id: string; readonly cls: string }): ReactNode {
  return (
    <marker id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path d="M0,0 L8,4 L0,8 z" className={cls} />
    </marker>
  );
}

function threadProps(t: XRayThread): { strokeWidth: number; opacity: number } {
  return t.touchesSelection ? { strokeWidth: 2, opacity: 1 } : { strokeWidth: 1.25, opacity: 0.55 };
}

/**
 * Spec 04 §5.3 — one SVG layer in window coordinates (the grid translates it with the cells). Ordinary threads are
 * inert; fractured threads are keyboard-reachable buttons that open the counterexample.
 */
export const XRayOverlay = memo(function XRayOverlay({ frame, frameId, onOpenCounterexample }: { readonly frame: XRayFrame; readonly frameId: number; readonly onOpenCounterexample: () => void }): ReactNode {
  const normal = frame.threads.filter((t) => !t.fractured);
  const fractured = frame.threads.filter((t) => t.fractured);
  const open = (e: { preventDefault(): void }): void => { e.preventDefault(); onOpenCounterexample(); };
  return (
    <svg data-testid="xray-overlay" data-frame-id={frameId} className="pointer-events-none absolute left-0 top-0 z-[3] overflow-visible" width="1" height="1">
      <defs>
        {ENGINES.map((e) => <Arrow key={e} id={`xr-arrow-${e}`} cls={ENGINE_FILL[e]} />)}
        <Arrow id="xr-arrow-fracture" cls="fill-fracture" />
      </defs>
      <g aria-hidden="true">
        {normal.map((t) => (
          <path key={t.id} d={t.d} data-testid="xray-thread" data-engine={t.engine} fill="none" className={ENGINE_STROKE[t.engine]}
            strokeDasharray={DASH[t.engine]} markerEnd={`url(#xr-arrow-${t.engine})`} {...threadProps(t)} />
        ))}
        {normal.filter((t) => t.flow).map((t) => (
          <path key={`flow-${t.id}`} d={t.d} data-testid="xray-flow" fill="none" className="suture-flow stroke-ink" strokeWidth={1.5} strokeDasharray="3 13" opacity={0.85} strokeLinecap="round" />
        ))}
        {frame.stubs.map((s) => (
          <g key={s.id} data-testid="xray-stub" data-sheet={s.sheet}>
            <path d={s.d} fill="none" strokeWidth={1.5} className={s.fractured ? 'stroke-fracture suture-pulse' : ENGINE_STROKE[s.engine]} strokeDasharray={s.fractured ? undefined : DASH[s.engine]} />
            <circle cx={s.anchor.x} cy={s.anchor.y} r={2.5} className={s.fractured ? 'fill-fracture' : ENGINE_FILL[s.engine]} />
          </g>
        ))}
      </g>
      {fractured.map((t) => {
        const label = `Failing lineage from ${t.edge.from} to ${t.edge.to}, open counterexample`;
        const common = { role: 'button', tabIndex: 0, 'aria-label': label, onClick: open, onKeyDown: (e: { key: string; preventDefault(): void }) => { if (e.key === 'Enter' || e.key === ' ') open(e); } } as const;
        return t.broken === null ? (
          <path key={t.id} d={t.d} data-testid="xray-fracture" fill="none" strokeWidth={2.25} className="suture-pulse cursor-pointer stroke-fracture focus:outline-none" style={{ pointerEvents: 'stroke' }} markerEnd="url(#xr-arrow-fracture)" {...common} />
        ) : (
          <g key={t.id} data-testid="xray-broken" className="cursor-pointer" style={{ pointerEvents: 'stroke' }} {...common}>
            <path d={t.broken.halves[0]} data-testid="xray-fracture" fill="none" strokeWidth={2.25} className="suture-pulse stroke-fracture" />
            <path d={t.broken.halves[1]} data-testid="xray-fracture" fill="none" strokeWidth={2.25} className="suture-pulse stroke-fracture" markerEnd="url(#xr-arrow-fracture)" />
            <path d={t.broken.ticks[0]} fill="none" strokeWidth={1.5} className="stroke-fracture" />
            <path d={t.broken.ticks[1]} fill="none" strokeWidth={1.5} className="stroke-fracture" />
          </g>
        );
      })}
    </svg>
  );
});
