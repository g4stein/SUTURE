import {
  assertionHolds, createExorcistSession, createWorkbookEngine, isCellError, NEVER_CANCELLED, sameValue, workbookHash,
  type CellKey, type CellValue, type Edit, type ReplayArtifact, type SutureDocument, type WorkbookEngine,
} from '@suture/core';
import { assertionLabel } from './format.ts';
import { toJson, type JsonValue } from './json.ts';
import { auditWorkbook, violationReport, type AuditReport, type ViolationReport } from './audit.ts';
import { evaluatedEngine, exorcistDepsFor, infoOf, resolveCell, type HeadlessHost, type Workbook, type WorkbookInfo } from './workbook.ts';

/** One cell's new content: a formula (`=…`), `=SQL(…)`, `=PY(…)`, a literal, or `''` to clear it. */
export interface CellPatch {
  readonly cell: string;
  readonly formula: string;
}

export type Regression =
  | { readonly kind: 'assertion'; readonly id: string; readonly cell: CellKey; readonly rule: string; readonly detail: string }
  | { readonly kind: 'newError'; readonly cell: CellKey; readonly code: string; readonly message: string };

export interface VerifyPatchReport {
  readonly format: 'suture.verify-patch';
  readonly version: 1;
  /** True only when the patch applies cleanly, fixes the original counterexample, the fresh audit passes, and nothing regressed. */
  readonly ok: boolean;
  readonly seed: number;
  readonly workbook: WorkbookInfo;
  readonly patchedHash: string;
  readonly patches: ReadonlyArray<{ readonly cell: CellKey; readonly before: string | null; readonly after: string }>;
  /** Patches that do not parse, or a configuration the patch broke; when present, nothing else ran. */
  readonly patchErrors: ReadonlyArray<string>;
  /** The counterexample the patch is checked against: from the given replay artifact, or from auditing the original. */
  readonly original: { readonly source: 'artifact' | 'audit'; readonly violation: ViolationReport | null };
  /** null when the original model had no counterexample to fix. */
  readonly counterexampleFixed: boolean | null;
  /** The original counterexample's violation on the patched model, when it still fails. */
  readonly counterexampleStillFails: ViolationReport | null;
  readonly freshAuditPassed: boolean;
  readonly freshAudit: Pick<AuditReport, 'mode' | 'verdict' | 'message' | 'search' | 'violation' | 'failingInputs'>;
  /** Checks that hold at the original base case and fail at the patched base case, and cells that newly evaluate to an error. */
  readonly regressions: ReadonlyArray<Regression>;
  /** Every cell whose base-case value the patch changed, row-major (informational: a real fix may change values). */
  readonly baseValueDiffs: ReadonlyArray<{ readonly cell: CellKey; readonly before: JsonValue; readonly after: JsonValue }>;
  readonly meta: { readonly durationMs: number };
}

/** Accepts `[{ cell, formula }]` or `{ "Sheet!A1": "=…" }`. */
export function normalizePatches(input: ReadonlyArray<CellPatch> | Readonly<Record<string, string>>): CellPatch[] {
  return Array.isArray(input) ? [...(input as ReadonlyArray<CellPatch>)] : Object.entries(input).map(([cell, formula]) => ({ cell, formula }));
}

function look(e: WorkbookEngine): (k: CellKey) => CellValue {
  return (k) => {
    const v = e.getValue(k);
    return v === 'pending' ? null : v;
  };
}

/**
 * Spec 05 Req 3.4 — re-runs the Exorcist on a patched copy of the model, in memory (nothing is written to disk):
 * 1. the original counterexample (from `artifact`, or from auditing the original with `seed`) is replayed on the patched
 *    model with every Tier 1 invariant and Tier 2 assertion;
 * 2. a fresh audit runs on the patched model with the same seed;
 * 3. both base cases are compared for regressions (checks that newly fail, cells that newly error) and value diffs.
 */
export async function verifyPatch(
  wb: Workbook, input: ReadonlyArray<CellPatch> | Readonly<Record<string, string>>, host: HeadlessHost,
  opts: { readonly seed?: number; readonly artifact?: ReplayArtifact } = {},
): Promise<VerifyPatchReport | { readonly error: string }> {
  const t0 = host.engine.clock.now();
  const list = normalizePatches(input);
  if (list.length === 0) return { error: 'give at least one cell patch' };
  if (opts.artifact !== undefined && opts.artifact.workbookHash !== wb.hash) {
    return { error: `the replay artifact was recorded on workbook ${opts.artifact.workbookHash}, not on ${wb.ref} (${wb.hash})` };
  }
  const seed = opts.seed ?? opts.artifact?.seed ?? host.randomSeed();

  // The patched document, built through the engine so its form (and hash) is canonical.
  const sources = new Map(wb.document.workbook.sheets.flatMap((s) => s.cells).map((c) => [c.key, c.raw] as const));
  const edits: Edit[] = [];
  const patches: Array<VerifyPatchReport['patches'][number]> = [];
  const seen = new Set<CellKey>();
  for (const p of list) {
    const r = resolveCell(wb, p.cell);
    if ('error' in r) return { error: `patch ${p.cell}: ${r.error}` };
    if (seen.has(r.key)) return { error: `patch ${r.key} appears twice` };
    seen.add(r.key);
    edits.push(p.formula === '' ? { kind: 'clearCell', key: r.key } : { kind: 'setCell', key: r.key, raw: p.formula });
    patches.push({ cell: r.key, before: sources.get(r.key) ?? null, after: p.formula });
  }
  const patchEngine = createWorkbookEngine(wb.document.workbook, host.engine);
  patchEngine.applyEdits(edits);
  const patchErrors: string[] = [];
  for (const p of patches) {
    const parsed = patchEngine.getParsed(p.cell);
    if (parsed?.dialect === 'formula' && 'parseError' in parsed) patchErrors.push(`${p.cell}: syntax error at offset ${parsed.parseError.offset}: ${parsed.parseError.message}`);
    if (parsed?.dialect === 'sql' && parsed.template.error !== undefined) patchErrors.push(`${p.cell}: ${parsed.template.error}`);
  }
  const patchedDoc: SutureDocument = { ...wb.document, workbook: patchEngine.definition() };
  const patched: Workbook = { ...wb, document: patchedDoc, hash: await workbookHash(patchedDoc, host.hasher) };
  const head = { format: 'suture.verify-patch' as const, version: 1 as const, seed, workbook: infoOf(wb), patchedHash: patched.hash, patches };
  const session = await createExorcistSession(patchedDoc, exorcistDepsFor(patched, host));
  if ('configError' in session) patchErrors.push(`the patched model's Exorcist configuration is invalid: ${session.configError}`);
  if (patchErrors.length > 0 || 'configError' in session) {
    return {
      ...head, ok: false, patchErrors, original: { source: opts.artifact !== undefined ? 'artifact' : 'audit', violation: null }, counterexampleFixed: null,
      counterexampleStillFails: null, freshAuditPassed: false, freshAudit: { mode: null, verdict: 'configError', message: patchErrors.join('; '), search: { runs: 0, scenarios: null, shrinkSteps: null }, violation: null, failingInputs: [] },
      regressions: [], baseValueDiffs: [], meta: { durationMs: Math.round(host.engine.clock.now() - t0) },
    };
  }

  // 1. The original counterexample, replayed on the patched model.
  let artifact: ReplayArtifact | null = opts.artifact ?? null;
  if (artifact === null) {
    const before = await auditWorkbook(wb, host, { seed });
    artifact = before.replay?.artifact ?? null;
  }
  let counterexampleFixed: boolean | null = null;
  let stillFails: ViolationReport | null = null;
  if (artifact !== null) {
    const out = await session.replay({ ...artifact, workbookHash: patched.hash }, NEVER_CANCELLED);
    counterexampleFixed = out.kind === 'notReproduced';
    if (out.kind === 'reproduced') stillFails = violationReport(out.violation);
  }

  // 2. A fresh audit of the patched model, same seed.
  const fresh = await auditWorkbook(patched, host, { seed });

  // 3. Base cases.
  const [a, b] = [await evaluatedEngine(wb, host), await evaluatedEngine(patched, host)];
  const regressions: Regression[] = [];
  for (const as of wb.document.exorcist.assertions) {
    if (as.kind === 'monotonicWith') continue; // a paired property: the fresh audit checks it
    const was = assertionHolds(as, look(a.engine), null);
    const now = assertionHolds(as, look(b.engine), null);
    if (was.ok && !now.ok) regressions.push({ kind: 'assertion', id: as.id, cell: as.cell, rule: assertionLabel(as), detail: now.detail });
  }
  const baseValueDiffs: Array<VerifyPatchReport['baseValueDiffs'][number]> = [];
  for (const s of patchedDoc.workbook.sheets) {
    for (const c of s.cells) {
      const x = look(a.engine)(c.key);
      const y = look(b.engine)(c.key);
      if (sameValue(x, y)) continue;
      baseValueDiffs.push({ cell: c.key, before: toJson(x), after: toJson(y) });
      if (isCellError(y) && !isCellError(x)) regressions.push({ kind: 'newError', cell: c.key, code: y.code, message: y.message });
    }
  }
  const freshAuditPassed = fresh.verdict === 'passed';
  return {
    ...head,
    ok: counterexampleFixed !== false && freshAuditPassed && regressions.length === 0,
    patchErrors: [], original: { source: opts.artifact !== undefined ? 'artifact' : 'audit', violation: artifact === null ? null : violationReport(artifact.violatedAssertion) },
    counterexampleFixed, counterexampleStillFails: stillFails, freshAuditPassed,
    freshAudit: { mode: fresh.mode, verdict: fresh.verdict, message: fresh.message, search: fresh.search, violation: fresh.violation, failingInputs: fresh.failingInputs },
    regressions, baseValueDiffs, meta: { durationMs: Math.round(host.engine.clock.now() - t0) },
  };
}
