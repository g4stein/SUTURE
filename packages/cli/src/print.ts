import type { FormulaAst } from '@suture/core';
import {
  formatNumber,
  type AuditReport, type Dialect, type EvalReport, type JsonValue, type LineageReport, type ReplayReport, type WorkbookInfo,
} from '@suture/runtime/headless';

/** Plain-text renderers for the human (non `--json`) output. No colors: the output is identical on every terminal. */

const CHIP: Readonly<Record<Dialect, string>> = { literal: '', formula: 'FX', sql: 'SQL', py: 'PY' };

export function valueText(v: JsonValue): string {
  if (v === null) return '(blank)';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if ('error' in v) return `${v.error}  ${v.message}`;
  if ('table' in v) return `table ${v.table.rows.toLocaleString('en-US')} × ${v.table.columns.length}`;
  if ('matrix' in v) return `matrix ${v.matrix.rows}×${v.matrix.cols}`;
  return '(pending)';
}

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
const width = (xs: ReadonlyArray<string>): number => xs.reduce((m, x) => Math.max(m, x.length), 0);

function header(w: WorkbookInfo): string[] {
  const py = w.python === 'blocked' ? 'Python: blocked (pass --trust-python to run this workbook\'s =PY() cells)' : `Python: ${w.python}`;
  return [`${w.title}  (${w.ref})`, `${w.hash}  ·  ${py}`, ''];
}

export function evalText(r: EvalReport): string {
  const out = header(r.workbook);
  const cw = width(r.cells.map((c) => c.cell));
  for (const c of r.cells) out.push(`${pad(c.cell, cw)}  ${pad(CHIP[c.dialect], 3)}  ${valueText(c.value)}`);
  out.push('', `${r.cells.length} cells · ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}${r.cycles.length > 0 ? ` · ${r.cycles.length} cycle(s)` : ''}`);
  return `${out.join('\n')}\n`;
}

const MODE: Readonly<Record<string, string>> = { inProcess: 'In-Process fast-check', batched: 'Batched WASM' };
const MARK: Readonly<Record<string, string>> = { held: '✓', violated: '✗', 'not reached': '·', 'not run': '·' };

export function auditText(r: AuditReport, replayFile: string | null): string {
  const out = header(r.workbook);
  if (r.verdict === 'configError') return `${[...out, `CONFIGURATION ERROR  ${r.message ?? ''}`].join('\n')}\n`;
  if (r.verdict === 'stopped') return `${[...out, 'STOPPED'].join('\n')}\n`;
  const runs = r.verdict === 'passed' ? `${r.search.runs.toLocaleString('en-US')} runs` : `failing run ${r.search.runs.toLocaleString('en-US')} · ${r.search.shrinkSteps ?? 0} shrink steps`;
  out.push(`Exorcist  ${MODE[r.mode ?? ''] ?? '—'} · seed ${r.seed} · ${runs}`, '');
  if (r.verdict === 'passed') out.push(`PASSED  no counterexample in ${r.search.runs.toLocaleString('en-US')} runs (${(r.search.scenarios ?? r.search.runs).toLocaleString('en-US')} scenarios)`);
  const v = r.violation;
  if (v !== null) {
    out.push(`VIOLATED  ${v.id}  ${v.cell ?? ''} ${v.rule}`.trimEnd(), `  ${v.detail}`, '', 'Minimal failing inputs (shrunk)');
    const iw = width(r.failingInputs.map((f) => f.cell));
    for (const f of r.failingInputs) out.push(`  ${pad(f.cell, iw)}  ${valueText(f.value)}`);
    out.push('', 'Failing lineage (counterexample, then base case)');
    const lw = width(r.lineage.map((l) => l.cell));
    for (const l of r.lineage) {
      const broken = r.failingEdge !== null && r.failingEdge.to === l.cell ? '  ✗' : '';
      out.push(`  ${pad(l.cell, lw)}  ${pad(l.dialect === null ? '' : CHIP[l.dialect], 3)}  ${valueText(l.value)}   (base ${valueText(l.base)})${broken}`);
    }
    if (r.failingEdge !== null) out.push(`  broken edge: ${r.failingEdge.from} → ${r.failingEdge.to}`);
  }
  out.push('', 'Tier 1 invariants');
  for (const t of r.tier1) out.push(`  ${MARK[t.status] ?? '·'} ${pad(t.id, 26)} ${t.status === 'held' ? t.label : `${t.status} — ${t.label}`}`);
  out.push('', 'Tier 2 assertions');
  const aw = width(r.tier2.map((t) => t.id));
  for (const t of r.tier2) out.push(`  ${MARK[t.status] ?? '·'} ${pad(t.id, aw)}  ${t.cell} ${t.rule}  — ${t.status}`);
  if (r.replay !== null) {
    out.push('', replayFile !== null ? `Replay artifact written to ${replayFile}` : 'Replay: pass --out-replay <file> to save the artifact');
    if (r.replay.fragment !== null) out.push(`Replay link fragment: #${r.replay.fragment}`);
  }
  return `${out.join('\n')}\n`;
}

export function replayText(r: ReplayReport): string {
  const out = header(r.workbook);
  const label: Readonly<Record<ReplayReport['outcome'], string>> = { exact: 'REPRODUCED (exact)', direct: 'REPRODUCED (direct, not exact)', notReproduced: 'NOT REPRODUCED', hashMismatch: 'HASH MISMATCH' };
  out.push(`${label[r.outcome]}  seed ${r.artifact.seed} · ${MODE[r.artifact.mode] ?? r.artifact.mode} · ${r.artifact.violated}`, `  ${r.detail}`);
  if (r.violation !== null) out.push(`  ${r.violation.id}: ${r.violation.detail}`);
  return `${out.join('\n')}\n`;
}

export function astText(a: FormulaAst): string {
  switch (a.t) {
    case 'num': return formatNumber(a.v);
    case 'str': return JSON.stringify(a.v);
    case 'bool': return a.v ? 'TRUE' : 'FALSE';
    case 'err': return a.code;
    case 'ref': return a.ref.text;
    case 'name': return a.name;
    case 'unary': return `(${a.op} ${astText(a.arg)})`;
    case 'percent': return `(% ${astText(a.arg)})`;
    case 'binary': return `(${a.op} ${astText(a.left)} ${astText(a.right)})`;
    case 'call': return `(${a.fn}${a.args.map((x) => ` ${astText(x)}`).join('')})`;
    case 'paren': return astText(a.arg);
  }
}

export function inspectText(r: LineageReport): string {
  const out = header(r.workbook);
  const list = (ks: ReadonlyArray<string>): string => (ks.length === 0 ? 'none' : ks.join(', '));
  out.push(`${r.cell}  ${r.dialect === null ? 'empty cell' : r.dialect === 'literal' ? 'literal' : `${CHIP[r.dialect]} ${r.dialect === 'formula' ? 'formula' : r.dialect === 'sql' ? 'DuckDB SQL' : 'Python (Pyodide + NumPy)'}`}`);
  if (r.raw !== null) out.push(`source      ${r.raw.split('\n').join('\n            ')}`);
  const p = r.parsed;
  if (p !== null) {
    if (p.kind === 'formula') out.push(`parsed      ${p.printed}`, `ast         ${astText(p.ast)}`);
    else if (p.kind === 'formulaError') out.push(`parse error at offset ${p.offset}: ${p.message}`);
    else if (p.kind === 'sql') out.push(`sql slots   ${p.slots.length === 0 ? 'none' : p.slots.map((s) => `${s.placeholder} ← ${s.ref}`).join(', ')}${p.error === null ? '' : `\nsql error   ${p.error}`}`);
    else if (p.kind === 'py') out.push(`py inputs   ${list(p.inputs)}${p.vectorized ? ' (vectorized)' : ''}`);
    else out.push(`value       ${valueText(p.value)}`);
  }
  out.push(`precedents  ${list(r.precedents)}`, `dependents  ${list(r.dependents)}`, `upstream    ${r.upstream.length} cell(s)`, `downstream  ${r.downstream.length} cell(s)`);
  out.push(`chain       ${r.chain.map((c) => (c === r.cell ? `[${c}]` : c)).join(' → ')}`);
  if (r.cyclic.length > 0) out.push(`cyclic      ${list(r.cyclic)}`);
  return `${out.join('\n')}\n`;
}
