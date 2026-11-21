import { useEffect, useState, type ReactNode } from 'react';
import { parseCellKey, toCellKey, type AssertionOperand, type CellAssertion, type CellKey, type FuzzInput } from '@suture/core';
import type { AppSnapshot, AppStore, AssertionStatus } from '../app/store.ts';

export const ASSERTION_KINDS: ReadonlyArray<{ readonly kind: CellAssertion['kind']; readonly label: string }> = [
  { kind: 'gte', label: '≥ (gte)' }, { kind: 'lte', label: '≤ (lte)' }, { kind: 'gt', label: '> (gt)' }, { kind: 'lt', label: '< (lt)' },
  { kind: 'between', label: 'between' }, { kind: 'notError', label: 'not error' }, { kind: 'finite', label: 'finite' }, { kind: 'notNull', label: 'not null' },
  { kind: 'monotonicWith', label: 'monotonic with' },
];

const field = 'h-6 rounded border bg-obsidian px-1.5 font-mono text-[11px] text-ink focus:outline-none';
const ok = 'border-slate-line focus:border-engine-formula';
const bad = 'border-fracture focus:border-fracture';

function canonical(text: string, fallbackSheet: string): CellKey | null {
  const t = text.trim();
  const c = parseCellKey(t.includes('!') ? t : `${fallbackSheet}!${t}`);
  return c === null ? null : toCellKey(c);
}

/** Text field that commits on Enter or blur only when `parse` accepts it; otherwise it stays red with a hint. */
function CommitField<T>({ value, parse, onCommit, label, width, testid }: {
  readonly value: string; readonly parse: (s: string) => T | null; readonly onCommit: (v: T) => void; readonly label: string; readonly width: string; readonly testid?: string;
}): ReactNode {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const parsed = parse(text);
  const commit = (): void => { if (parsed !== null && text !== value) onCommit(parsed); };
  return (
    <input aria-label={label} title={parsed === null ? `${label}: invalid value` : label} data-testid={testid} value={text} spellCheck={false}
      aria-invalid={parsed === null}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      className={`${field} ${width} ${parsed === null ? bad : ok}`} />
  );
}

const parseNum = (s: string): number | null => { const t = s.trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

function OperandEditor({ op, sheet, onChange, label, testid }: { readonly op: AssertionOperand; readonly sheet: string; readonly onChange: (o: AssertionOperand) => void; readonly label: string; readonly testid: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      <select aria-label={`${label} kind`} value={op.kind} className={`${field} ${ok}`}
        onChange={(e) => onChange(e.target.value === 'cell' ? { kind: 'cell', cell: toCellKey({ sheet, row: 0, col: 0 }) } : { kind: 'const', value: 0 })}>
        <option value="const">const</option>
        <option value="cell">cell</option>
      </select>
      {op.kind === 'const'
        ? <CommitField label={label} testid={testid} width="w-24" value={String(op.value)} parse={parseNum} onCommit={(v) => onChange({ kind: 'const', value: v })} />
        : <CommitField label={label} testid={testid} width="w-28" value={op.cell} parse={(s) => canonical(s, sheet)} onCommit={(c) => onChange({ kind: 'cell', cell: c })} />}
    </span>
  );
}

function withKind(a: CellAssertion, kind: CellAssertion['kind'], inputs: ReadonlyArray<FuzzInput>): CellAssertion {
  const base = { id: a.id, cell: a.cell };
  const operand = a.kind === 'gte' || a.kind === 'lte' || a.kind === 'gt' || a.kind === 'lt' ? a.operand : { kind: 'const' as const, value: 0 };
  switch (kind) {
    case 'gte': case 'lte': case 'gt': case 'lt': return { ...base, kind, operand };
    case 'between': return { ...base, kind, min: a.kind === 'between' ? a.min : operand, max: a.kind === 'between' ? a.max : { kind: 'const', value: 1 } };
    case 'monotonicWith': return { ...base, kind, input: a.kind === 'monotonicWith' ? a.input : (inputs[0]?.cell ?? a.cell), direction: a.kind === 'monotonicWith' ? a.direction : 'nonDecreasing' };
    default: return { ...base, kind };
  }
}

function StatusChip({ s }: { readonly s: AssertionStatus | undefined }): ReactNode {
  if (s === undefined) return null;
  const cls = s.ok === null ? 'border-slate-line text-ink-muted' : s.ok ? 'border-engine-formula/60 text-engine-formula' : 'border-fracture text-fracture';
  return (
    <span data-testid={`assert-${s.id}`} data-ok={s.ok === null ? 'unknown' : String(s.ok)} title={s.detail} className={`rounded border px-1.5 font-mono text-[10px] ${cls}`}>
      {s.ok === null ? '…' : s.ok ? 'holds now' : 'fails now'}
    </span>
  );
}

function AssertionRow({ a, index, snap, store }: { readonly a: CellAssertion; readonly index: number; readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const cfg = snap.config;
  const sheet = parseCellKey(a.cell)?.sheet ?? snap.activeSheet;
  const replace = (next: CellAssertion): void => store.updateConfig({ ...cfg, assertions: cfg.assertions.map((x, i) => (i === index ? next : x)) });
  const status = snap.assertions.find((s) => s.id === a.id);
  const ids = cfg.assertions.filter((_, i) => i !== index).map((x) => x.id);
  return (
    <li data-testid={`assertion-row-${index}`} className="space-y-1.5 rounded-md border border-slate-line bg-obsidian/40 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <CommitField label="Assertion id" testid={`assertion-id-${index}`} width="w-40" value={a.id} parse={(s) => (s.trim() !== '' && !ids.includes(s.trim()) ? s.trim() : null)} onCommit={(id) => replace({ ...a, id })} />
        <StatusChip s={status} />
        <button type="button" aria-label={`Remove assertion ${a.id}`} data-testid={`assertion-remove-${index}`} onClick={() => store.updateConfig({ ...cfg, assertions: cfg.assertions.filter((_, i) => i !== index) })} className="ml-auto text-ink-muted hover:text-fracture">✕</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <CommitField label="Cell" testid={`assertion-cell-${index}`} width="w-28" value={a.cell} parse={(s) => canonical(s, sheet)} onCommit={(cell) => replace({ ...a, cell })} />
        <select aria-label="Assertion kind" data-testid={`assertion-kind-${index}`} value={a.kind} onChange={(e) => replace(withKind(a, e.target.value as CellAssertion['kind'], cfg.inputs))} className={`${field} ${ok}`}>
          {ASSERTION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        {(a.kind === 'gte' || a.kind === 'lte' || a.kind === 'gt' || a.kind === 'lt') && (
          <OperandEditor op={a.operand} sheet={sheet} label="Operand" testid={`assertion-operand-${index}`} onChange={(operand) => replace({ ...a, operand })} />
        )}
        {a.kind === 'between' && (
          <>
            <OperandEditor op={a.min} sheet={sheet} label="Minimum" testid={`assertion-min-${index}`} onChange={(min) => replace({ ...a, min })} />
            <span className="text-ink-muted">and</span>
            <OperandEditor op={a.max} sheet={sheet} label="Maximum" testid={`assertion-max-${index}`} onChange={(max) => replace({ ...a, max })} />
          </>
        )}
        {a.kind === 'monotonicWith' && (
          <>
            <select aria-label="Monotonic input" value={a.input} onChange={(e) => replace({ ...a, input: e.target.value as CellKey })} className={`${field} ${cfg.inputs.some((i) => i.cell === a.input) ? ok : bad}`}>
              {!cfg.inputs.some((i) => i.cell === a.input) && <option value={a.input}>{a.input} (not a fuzz input)</option>}
              {cfg.inputs.map((i) => <option key={i.cell} value={i.cell}>{i.cell}</option>)}
            </select>
            <select aria-label="Direction" value={a.direction} onChange={(e) => replace({ ...a, direction: e.target.value === 'nonIncreasing' ? 'nonIncreasing' : 'nonDecreasing' })} className={`${field} ${ok}`}>
              <option value="nonDecreasing">non-decreasing</option>
              <option value="nonIncreasing">non-increasing</option>
            </select>
          </>
        )}
      </div>
    </li>
  );
}

function DomainRow({ inp, index, snap, store }: { readonly inp: FuzzInput; readonly index: number; readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const cfg = snap.config;
  const d = inp.domain;
  const replace = (next: FuzzInput): void => store.updateConfig({ ...cfg, inputs: cfg.inputs.map((x, i) => (i === index ? next : x)) });
  if (d.kind !== 'float' && d.kind !== 'integer') {
    return <li className="rounded-md border border-slate-line p-2 font-mono text-[11px] text-ink-muted">{inp.cell}: {d.kind} domain (edit in the .suture.json)</li>;
  }
  const parseBound = (s: string): number | null => { const n = parseNum(s); return n === null ? null : d.kind === 'integer' && !Number.isInteger(n) ? null : n; };
  const invalid = d.min > d.max;
  return (
    <li data-testid={`domain-row-${index}`} className={`flex flex-wrap items-center gap-1.5 rounded-md border bg-obsidian/40 p-2 ${invalid ? 'border-fracture' : 'border-slate-line'}`}>
      <button type="button" onClick={() => store.select(inp.cell)} className="font-mono text-[11px] text-ink hover:underline">{inp.cell}</button>
      <select aria-label="Domain kind" value={d.kind} onChange={(e) => replace({ ...inp, domain: e.target.value === 'integer' ? { kind: 'integer', min: Math.ceil(d.min), max: Math.floor(d.max) } : { kind: 'float', min: d.min, max: d.max } })} className={`${field} ${ok}`}>
        <option value="float">float</option>
        <option value="integer">integer</option>
      </select>
      <CommitField label="Domain minimum" testid={`domain-min-${index}`} width="w-24" value={String(d.min)} parse={parseBound} onCommit={(min) => replace({ ...inp, domain: { ...d, min } })} />
      <span className="text-ink-muted">to</span>
      <CommitField label="Domain maximum" testid={`domain-max-${index}`} width="w-24" value={String(d.max)} parse={parseBound} onCommit={(max) => replace({ ...inp, domain: { ...d, max } })} />
      <button type="button" aria-label={`Remove fuzz domain on ${inp.cell}`} onClick={() => store.updateConfig({ ...cfg, inputs: cfg.inputs.filter((_, i) => i !== index) })} className="ml-auto text-ink-muted hover:text-fracture">✕</button>
      {invalid && <span className="w-full text-[10px] text-fracture">minimum must not exceed maximum</span>}
    </li>
  );
}

/** Spec 04 §12 — Assertions & Domains: all 9 assertion kinds, constant or cell operands, float/integer domains. */
export function AssertionsTab({ snap, store }: { readonly snap: AppSnapshot; readonly store: AppStore }): ReactNode {
  const cfg = snap.config;
  const sel = snap.selection;
  const literal = store.literalNumber(sel);
  const isInput = cfg.inputs.some((i) => i.cell.toUpperCase() === sel.toUpperCase());
  const hasSource = store.source(sel) !== null;
  const addDomain = (): void => {
    if (literal === null) return;
    const integer = Number.isInteger(literal);
    const lo = literal === 0 ? 0 : Math.min(literal * 0.5, literal * 1.5);
    const hi = literal === 0 ? 1 : Math.max(literal * 0.5, literal * 1.5);
    const domain = integer ? { kind: 'integer' as const, min: Math.floor(lo), max: Math.ceil(hi) } : { kind: 'float' as const, min: lo, max: hi };
    store.updateConfig({ ...cfg, inputs: [...cfg.inputs, { cell: sel, domain }] });
  };
  const addAssertion = (): void => {
    const c = parseCellKey(sel);
    const stem = `${(c?.sheet ?? 'cell').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${sel.slice(sel.lastIndexOf('!') + 1).toLowerCase()}`;
    let id = `${stem}-non-negative`;
    for (let i = 2; cfg.assertions.some((a) => a.id === id); i++) id = `${stem}-${i}`;
    store.updateConfig({ ...cfg, assertions: [...cfg.assertions, { id, cell: sel, kind: 'gte', operand: { kind: 'const', value: 0 } }] });
  };
  return (
    <div className="space-y-4 text-xs">
      <div data-testid="config-check" data-ok={snap.configCheck.ok} className={`rounded-md border px-2 py-1.5 ${snap.configCheck.ok ? 'border-engine-formula/40 text-engine-formula' : 'border-engine-py/50 text-engine-py'}`}>
        {snap.configCheck.ok ? `Ready to exorcise · ${snap.configCheck.mode === 'batched' ? 'Batched WASM' : 'In-Process fast-check'} mode · ${cfg.inputs.length} input(s), ${cfg.assertions.length} assertion(s)` : snap.configCheck.message}
      </div>
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-wider text-ink-muted">Fuzz domains</h3>
          <button type="button" data-testid="add-domain" disabled={literal === null || isInput} onClick={addDomain}
            title={literal === null ? 'Select a cell holding a literal number' : isInput ? 'Already a fuzz input' : `Fuzz ${sel}`}
            className="rounded border border-slate-line px-2 py-0.5 font-mono text-[11px] text-ink hover:border-engine-formula disabled:opacity-40">+ Domain on {sel.slice(sel.lastIndexOf('!') + 1)}</button>
        </div>
        {cfg.inputs.length === 0 && <div className="text-ink-muted">No fuzz inputs. Select a literal number cell and add a domain.</div>}
        <ul className="space-y-1.5">{cfg.inputs.map((inp, i) => <DomainRow key={`${i}:${inp.cell}`} inp={inp} index={i} snap={snap} store={store} />)}</ul>
      </section>
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-wider text-ink-muted">Tier 2 assertions</h3>
          <button type="button" data-testid="add-assertion" disabled={!hasSource} onClick={addAssertion}
            className="rounded border border-slate-line px-2 py-0.5 font-mono text-[11px] text-ink hover:border-engine-formula disabled:opacity-40">+ Assertion on {sel.slice(sel.lastIndexOf('!') + 1)}</button>
        </div>
        {cfg.assertions.length === 0 && <div className="text-ink-muted">No assertions. Select a computed cell and add one.</div>}
        <ul className="space-y-1.5">{cfg.assertions.map((a, i) => <AssertionRow key={i} a={a} index={i} snap={snap} store={store} />)}</ul>
      </section>
    </div>
  );
}
