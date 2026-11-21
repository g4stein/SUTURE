import { useMemo, type ReactNode } from 'react';
import type { CellKey, TableRef } from '@suture/core';
import type { AppSnapshot, AppStore } from '../app/store.ts';
import { previewTable } from './preview.ts';

function PreviewTable({ table, label }: { readonly table: TableRef; readonly label: string }): ReactNode {
  const p = useMemo(() => previewTable(table), [table]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between px-3 py-1.5 font-mono text-[11px]">
        <span className="text-ink">{label} <span className="text-ink-muted">— {p.total.toLocaleString('en-US')} × {p.columns.length}</span></span>
        <span className="text-ink-muted" data-testid="drawer-decoded" data-decoded={p.decoded}>showing first {p.decoded.toLocaleString('en-US')} rows (decoded {p.decoded})</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-slate-line">
        <table className="w-max min-w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-slate-raised">
            <tr>
              <th className="border-b border-r border-slate-line px-2 py-1 text-right font-normal text-ink-muted">#</th>
              {p.columns.map((c) => (
                <th key={c.name} className="border-b border-r border-slate-line px-2 py-1 text-left font-normal">
                  <span className="text-ink">{c.name}</span> <span className="text-ink-muted">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i} data-testid="drawer-row" className="hover:bg-slate-raised">
                <td className="border-b border-r border-slate-line/60 px-2 text-right text-ink-muted">{i + 1}</td>
                {r.map((v, j) => <td key={j} className="tabular whitespace-nowrap border-b border-r border-slate-line/60 px-2 text-ink">{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Collapsible Table / Dataset Preview drawer under the grid (Spec 04 Req 3.3: at most the first 100 rows decoded). */
export function Drawer({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const d = snap.drawer;
  if (d === null) return null;
  let body: ReactNode;
  if (d.kind === 'cell') {
    const v = store.value(d.key as CellKey);
    body = v !== 'pending' && v !== null && typeof v === 'object' && v.kind === 'table'
      ? <PreviewTable table={v} label={d.key} />
      : <div className="p-3 text-xs text-ink-muted">{d.key} is not a table (yet).</div>;
  } else if (d.kind === 'dataset') {
    const ds = store.dataset(d.name);
    body = ds === null ? <div className="p-3 text-xs text-ink-muted">Dataset {d.name} is not registered.</div> : <PreviewTable table={ds.preview} label={`dataset ${d.name}`} />;
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        {snap.datasets.length === 0 && <div className="text-ink-muted">No datasets yet. Import a .csv, .parquet, or .xlsx file (or drop it anywhere); then query it with =SQL("SELECT … FROM name").</div>}
        <ul className="space-y-1.5">
          {snap.datasets.map((ds) => (
            <li key={ds.meta.name} data-testid={`dataset-${ds.meta.name}`} className="rounded-md border border-slate-line p-2">
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => store.openDrawer({ kind: 'dataset', name: ds.meta.name })} className="font-mono text-engine-sql hover:underline">{ds.meta.name}</button>
                <span className="tabular font-mono text-ink-muted">{ds.meta.rowCount.toLocaleString('en-US')} rows · {ds.meta.schema.length} cols · {ds.meta.format}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">{ds.meta.schema.map((f) => <span key={f.name} className="rounded border border-slate-line px-1 font-mono text-[10px] text-ink-muted">{f.name}:{f.arrowType}</span>)}</div>
            </li>
          ))}
        </ul>
        {snap.imports.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-ink-muted">Import reports</div>
            <ul className="space-y-1">
              {snap.imports.map((r) => (
                <li key={r.id} data-testid="import-report" data-ok={r.ok} className={`rounded border px-2 py-1 ${r.ok ? 'border-slate-line text-ink' : 'border-fracture/60 text-fracture'}`}>
                  <span className="font-mono">{r.file}</span>: {r.message}{r.warnings.length > 0 && <span className="text-ink-muted"> · {r.warnings.join('; ')}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  return (
    <section data-testid="table-drawer" aria-label="Table and dataset preview" className="flex h-[38vh] min-h-[11rem] flex-col border-t border-slate-line bg-slate-surface md:h-64">
      <div className="flex items-center gap-3 border-b border-slate-line bg-slate-raised px-3 py-1 font-mono text-[11px]">
        <button type="button" data-testid="drawer-datasets" onClick={() => store.openDrawer({ kind: 'datasets' })} className={d.kind === 'datasets' ? 'text-engine-sql' : 'text-ink-muted hover:text-ink'}>Datasets</button>
        <span className="text-ink-muted">{d.kind === 'cell' ? `Preview · ${d.key}` : d.kind === 'dataset' ? `Preview · ${d.name}` : ''}</span>
        <button type="button" data-testid="drawer-close" onClick={() => store.openDrawer(null)} className="ml-auto text-ink-muted hover:text-ink" aria-label="Close preview">✕</button>
      </div>
      {body}
    </section>
  );
}
