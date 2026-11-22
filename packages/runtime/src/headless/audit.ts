import {
  createExorcistSession, decodeScalar, NEVER_CANCELLED, toReplayFragment,
  type CancellationToken, type CellKey, type ExecutionMode, type ExorcistVerdict, type LineageEdge, type ReplayArtifact, type ReplayOutcome,
  type ViolatedAssertion,
} from '@suture/core';
import { assertionLabel, TIER1_INVARIANTS } from './format.ts';
import { scalarJson, summaryJson, toJson, type JsonValue } from './json.ts';
import { dialectOf, evaluatedEngine, exorcistDepsFor, infoOf, type Dialect, type HeadlessHost, type Workbook, type WorkbookInfo } from './workbook.ts';

export type Tier1Status = 'held' | 'violated' | 'not run';
export type Tier2Status = 'held' | 'violated' | 'not reached' | 'not run';

export interface ViolationReport {
  readonly tier: 1 | 2;
  /** The assertion id (Tier 2) or the invariant id (Tier 1). */
  readonly id: string;
  readonly cell: CellKey | null;
  /** The expected rule: `>= 0`, or the invariant's description. */
  readonly rule: string;
  readonly detail: string;
  readonly observed: JsonValue | null;
}

export interface AuditReport {
  readonly format: 'suture.audit';
  readonly version: 1;
  readonly workbook: WorkbookInfo;
  readonly seed: number;
  readonly mode: ExecutionMode | null;
  readonly verdict: 'passed' | 'violated' | 'configError' | 'stopped';
  /** The configuration problem, when `verdict` is `configError`. */
  readonly message: string | null;
  /**
   * `runs`: runs until the first failing run (violated) or all runs (passed). `shrinkSteps`: accepted shrink steps,
   * read from the replay path. Both are deterministic for a given seed.
   */
  readonly search: { readonly runs: number; readonly scenarios: number | null; readonly shrinkSteps: number | null };
  readonly tier1: ReadonlyArray<{ readonly id: string; readonly label: string; readonly status: Tier1Status }>;
  readonly tier2: ReadonlyArray<{ readonly id: string; readonly cell: CellKey; readonly rule: string; readonly status: Tier2Status }>;
  readonly violation: ViolationReport | null;
  /** The shrunk counterexample, sorted by cell. */
  readonly failingInputs: ReadonlyArray<{ readonly cell: CellKey; readonly value: JsonValue }>;
  /** The failing lineage from the shrunk inputs to the violated cell: each cell under the counterexample and at the base case. */
  readonly lineage: ReadonlyArray<{ readonly cell: CellKey; readonly dialect: Dialect | null; readonly value: JsonValue; readonly base: JsonValue }>;
  readonly failingEdge: LineageEdge | null;
  /** The replay artifact (its `createdAt` is wall-clock) and its `#replay=v1.` fragment when it fits in 8,192 characters. */
  readonly replay: { readonly artifact: ReplayArtifact; readonly fragment: string | null } | null;
  /** Wall-clock values only; everything outside `meta` (and the artifact's `createdAt`) is identical for the same seed. */
  readonly meta: { readonly durationMs: number };
}

export function violationReport(va: ViolatedAssertion): ViolationReport {
  if (va.tier === 2) return { tier: 2, id: va.assertion.id, cell: va.assertion.cell, rule: assertionLabel(va.assertion), detail: va.detail, observed: summaryJson(va.observed) };
  return { tier: 1, id: va.invariant, cell: va.cell, rule: TIER1_INVARIANTS.find((t) => t.id === va.invariant)?.label ?? va.invariant, detail: va.detail, observed: null };
}

/** `runs` and `shrinkSteps` from a replay path (`start:shrink:…|digits`, in both execution modes). */
function pathStats(path: string): { readonly runs: number; readonly shrinkSteps: number } {
  const steps = (path.split('|')[0] ?? '').split(':').filter((s) => s !== '');
  return { runs: Number(steps[0] ?? 0) + 1, shrinkSteps: Math.max(0, steps.length - 1) };
}

function tierStatuses(wb: Workbook, verdict: ExorcistVerdict): Pick<AuditReport, 'tier1' | 'tier2'> {
  const va = verdict.kind === 'violated' ? verdict.artifact.violatedAssertion : null;
  const ran = verdict.kind === 'passed' || verdict.kind === 'violated';
  const t1 = (id: string): Tier1Status => (!ran ? 'not run' : va !== null && va.tier === 1 && va.invariant === id ? 'violated' : 'held');
  // First violation wins (Spec 03 §4): assertions after it were not checked on the failing run.
  const t2 = (id: string): Tier2Status => (!ran ? 'not run' : va === null ? 'held' : va.tier === 2 && va.assertion.id === id ? 'violated' : 'not reached');
  const tier1 = TIER1_INVARIANTS.map((t) => ({ id: t.id, label: t.label, status: t1(t.id) }));
  const tier2 = wb.document.exorcist.assertions.map((a) => ({ id: a.id, cell: a.cell, rule: assertionLabel(a), status: t2(a.id) }));
  return { tier1, tier2 };
}

/** Runs the Exorcist headlessly with real engines (Spec 05 Req 2.2 / 3.3). Deterministic for a given seed. */
export async function auditWorkbook(wb: Workbook, host: HeadlessHost, opts: { readonly seed?: number; readonly token?: CancellationToken } = {}): Promise<AuditReport> {
  const seed = opts.seed ?? host.randomSeed();
  const token = opts.token ?? NEVER_CANCELLED;
  const t0 = host.engine.clock.now();
  const base = { format: 'suture.audit' as const, version: 1 as const, workbook: infoOf(wb), seed };
  const session = await createExorcistSession(wb.document, exorcistDepsFor(wb, host));
  if ('configError' in session) {
    return {
      ...base, mode: null, verdict: 'configError', message: session.configError, search: { runs: 0, scenarios: null, shrinkSteps: null },
      ...tierStatuses(wb, { kind: 'configError', message: session.configError }), violation: null, failingInputs: [], lineage: [], failingEdge: null, replay: null,
      meta: { durationMs: Math.round(host.engine.clock.now() - t0) },
    };
  }
  const verdict = await session.run({ seed, token, onProgress: () => undefined });
  const done = (): { readonly durationMs: number } => ({ durationMs: Math.round(host.engine.clock.now() - t0) });
  if (verdict.kind !== 'violated') {
    return {
      ...base, mode: session.mode, verdict: verdict.kind, message: verdict.kind === 'configError' ? verdict.message : null,
      search: verdict.kind === 'passed' ? { runs: verdict.runs, scenarios: verdict.scenarios, shrinkSteps: null } : { runs: 0, scenarios: null, shrinkSteps: null },
      ...tierStatuses(wb, verdict), violation: null, failingInputs: [], lineage: [], failingEdge: null, replay: null, meta: done(),
    };
  }
  const a = verdict.artifact;
  const { engine } = await evaluatedEngine(wb, host);
  const cells = a.lineagePath.cells;
  const scenario = await engine.evaluateScenarioBatch({
    scenarios: [a.failingInputs.map((f) => ({ cell: f.cell, value: decodeScalar(f.value) }))], targets: cells, tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED,
  });
  const under = scenario.values[0];
  const lineage = cells.map((c) => {
    const b = engine.getValue(c);
    return { cell: c, dialect: dialectOf(engine.getParsed(c)), value: toJson(under?.get(c) ?? (b === 'pending' ? null : b)), base: toJson(b) };
  });
  const fragment = await toReplayFragment(a, host.compressor);
  return {
    ...base, mode: a.mode, verdict: 'violated', message: null, search: { ...pathStats(a.path), scenarios: null }, ...tierStatuses(wb, verdict),
    violation: violationReport(a.violatedAssertion), failingInputs: a.failingInputs.map((f) => ({ cell: f.cell, value: scalarJson(f.value) })),
    lineage, failingEdge: a.lineagePath.failingEdge, replay: { artifact: a, fragment: typeof fragment === 'string' ? fragment : null }, meta: done(),
  };
}

export interface ReplayReport {
  readonly format: 'suture.replay-check';
  readonly version: 1;
  readonly workbook: WorkbookInfo;
  readonly artifact: { readonly seed: number; readonly mode: ExecutionMode; readonly workbookHash: string; readonly violated: string };
  /** `exact`: the seed and path regenerate the same failing inputs bit for bit; `direct`: the stored inputs still fail. */
  readonly outcome: 'exact' | 'direct' | 'notReproduced' | 'hashMismatch';
  readonly detail: string;
  readonly violation: ViolationReport | null;
}

/** Replays an exported counterexample against the workbook and reports whether it reproduces exactly (Spec 05 Req 2.3). */
export async function replayWorkbook(wb: Workbook, artifact: ReplayArtifact, host: HeadlessHost): Promise<ReplayReport | { readonly error: string }> {
  const session = await createExorcistSession(wb.document, exorcistDepsFor(wb, host));
  if ('configError' in session) return { error: `the workbook's Exorcist configuration is invalid: ${session.configError}` };
  const out: ReplayOutcome = await session.replay(artifact, NEVER_CANCELLED);
  const va = artifact.violatedAssertion;
  const head = {
    format: 'suture.replay-check' as const, version: 1 as const, workbook: infoOf(wb),
    artifact: { seed: artifact.seed, mode: artifact.mode, workbookHash: artifact.workbookHash, violated: va.tier === 2 ? va.assertion.id : va.invariant },
  };
  switch (out.kind) {
    case 'reproduced':
      return { ...head, outcome: out.exact ? 'exact' : 'direct', detail: out.exact ? 'the seed and path regenerated the same failing inputs, and they fail the same way' : 'the stored failing inputs fail, but the seed and path did not regenerate them bit for bit', violation: violationReport(out.violation) };
    case 'notReproduced':
      return { ...head, outcome: 'notReproduced', detail: out.detail, violation: null };
    case 'hashMismatch':
      return { ...head, outcome: 'hashMismatch', detail: `the artifact was recorded on workbook ${out.expected}; this workbook is ${out.actual}`, violation: null };
  }
}
