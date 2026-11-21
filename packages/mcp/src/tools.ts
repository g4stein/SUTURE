import { readFileSync } from 'node:fs';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { isReplayArtifact } from '@suture/core';
import { SUTURE_VERSION } from '@suture/runtime/bridge';
import { auditWorkbook, inspectLineage, openWorkbook, verifyPatch, type HeadlessHost } from '@suture/runtime/headless';
import { findWorkbookFiles, loadWorkbook, resolveFile } from '@suture/runtime/node';
import { FLAGSHIPS, validateDocument } from '@suture/runtime/workbooks';

/**
 * Spec 05 Req 3 — the four Suture tools. Every argument arrives as untrusted JSON: zod narrows the shapes, workbook paths
 * must resolve inside the workspace root, replay artifacts go through `isReplayArtifact`, and nothing is written to disk.
 */
export interface ToolContext {
  readonly host: HeadlessHost;
  /** Workspace root: workbook paths resolve against it and must stay inside it. */
  readonly root: string;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(report: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }], structuredContent: report };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The engines are single-threaded and shared: tool calls that evaluate run one at a time, in arrival order. */
function serialized(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

const workbookArg = z.string().min(1).describe('flagship:1, flagship:2, or a .suture.json path relative to the workspace root');
const trustArg = z.boolean().optional().describe('Run =PY() cells of a .suture.json file. Python under Node can reach the file system and network; leave false unless the user trusts this workbook. Built-in flagships always run.');
const seedArg = z.number().int().min(-2147483648).max(4294967295).optional().describe('Exorcist seed; omit for a fresh random seed (reported in the result)');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const exclusive = serialized();
  const load = (ref: string, trustPython: boolean | undefined) => loadWorkbook(ref, { trustPython: trustPython === true, base: ctx.root, root: ctx.root }, ctx.host);

  server.registerTool('suture_list_workbooks', {
    title: 'List Suture workbooks',
    description: 'Lists the built-in flagship workbooks (flagship:1, flagship:2) and every .suture.json workbook in the workspace, with their sheets, cell counts, fuzz inputs, assertions, and whether Python would run.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
  }, async () => {
    const flagships: Array<Record<string, unknown>> = [];
    for (const f of FLAGSHIPS) {
      const wb = await openWorkbook(f.id, 'flagship', f.make(), true, ctx.host);
      const d = wb.document;
      flagships.push({
        id: f.id, title: d.title, summary: f.summary, hash: wb.hash, sheets: d.workbook.sheets.map((s) => s.name),
        cells: d.workbook.sheets.reduce((n, s) => n + s.cells.length, 0), inputs: d.exorcist.inputs.length, assertions: d.exorcist.assertions.map((a) => a.id), python: wb.python,
      });
    }
    const files: Array<Record<string, unknown>> = [];
    for (const path of findWorkbookFiles(ctx.root)) {
      const f = resolveFile(path, ctx.root, ctx.root);
      if ('error' in f) { files.push({ path, error: f.error }); continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(f.path, 'utf8')); } catch (e) { files.push({ path, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }); continue; }
      const check = validateDocument(parsed);
      if (!check.ok) { files.push({ path, error: `not a Suture workbook: ${check.path} ${check.message}` }); continue; }
      const wb = await openWorkbook(path, 'file', check.document, false, ctx.host);
      const d = wb.document;
      files.push({
        path, title: d.title, hash: wb.hash, sheets: d.workbook.sheets.map((s) => s.name), cells: d.workbook.sheets.reduce((n, s) => n + s.cells.length, 0),
        inputs: d.exorcist.inputs.length, assertions: d.exorcist.assertions.map((a) => a.id), python: wb.python, pyCells: wb.pyCells.length,
      });
    }
    return ok({ format: 'suture.workbooks', version: 1, sutureVersion: SUTURE_VERSION, root: ctx.root, flagships, files });
  });

  server.registerTool('suture_inspect_lineage', {
    title: 'Inspect a cell\'s lineage',
    description: 'Returns a cell\'s dialect (literal, formula, sql, py), its source and parsed form (formula AST, SQL slots, Python inputs), its direct precedents and dependents, every upstream and downstream cell, and the full topological chain through the cross-engine DAG. Static: no engine runs.',
    inputSchema: z.object({ workbook: workbookArg, cell: z.string().min(1).describe('Sheet!A1, for example Model!B5') }),
    annotations: READ_ONLY,
  }, async ({ workbook, cell }) => {
    const wb = await load(workbook, false);
    if ('error' in wb) return fail(wb.error);
    const r = inspectLineage(wb, cell, ctx.host);
    return 'error' in r ? fail(r.error) : ok({ ...r });
  });

  server.registerTool('suture_run_audit', {
    title: 'Run the Exorcist audit',
    description: 'Fuzzes the workbook\'s declared inputs through every engine (DuckDB-WASM, Pyodide + NumPy, formulas) with property-based testing. Returns the verdict, Tier 1 invariant and Tier 2 assertion statuses, the shrunk failingInputs, the failing lineagePath evaluated under the counterexample, and the replay artifact (pass it to suture_verify_patch). Deterministic for a given seed; nothing is written to disk.',
    inputSchema: z.object({ workbook: workbookArg, seed: seedArg, trustPython: trustArg }),
    annotations: { ...READ_ONLY, idempotentHint: false },
  }, ({ workbook, seed, trustPython }) => exclusive(async () => {
    const wb = await load(workbook, trustPython);
    if ('error' in wb) return fail(wb.error);
    return ok({ ...(await auditWorkbook(wb, ctx.host, seed === undefined ? {} : { seed })) });
  }));

  server.registerTool('suture_verify_patch', {
    title: 'Verify a formula patch',
    description: 'Applies one or more cell patches to an in-memory copy of the workbook (the file on disk is never changed), replays the original counterexample against the patched model, runs a fresh Exorcist audit with the same seed, and compares both base cases. ok is true only when the counterexample is fixed, the fresh audit passes, and there are zero regressions.',
    inputSchema: z.object({
      workbook: workbookArg,
      patches: z.union([
        z.array(z.object({ cell: z.string().min(1), formula: z.string() })).min(1),
        z.record(z.string(), z.string()),
      ]).describe('[{ "cell": "Model!B5", "formula": "=IF(B4<=0,120,Inputs!B2/B4)" }] or { "Model!B5": "=IF(…)" }; an empty formula clears the cell'),
      replayArtifact: z.unknown().optional().describe('The replay artifact from suture_run_audit (its seed is reused); without it the original model is audited first'),
      seed: seedArg,
      trustPython: trustArg,
    }),
    annotations: { ...READ_ONLY, idempotentHint: false },
  }, ({ workbook, patches, replayArtifact, seed, trustPython }) => exclusive(async () => {
    if (replayArtifact !== undefined && !isReplayArtifact(replayArtifact)) return fail('replayArtifact is not a Suture replay artifact (format suture.replay, version 1)');
    const wb = await load(workbook, trustPython);
    if ('error' in wb) return fail(wb.error);
    const r = await verifyPatch(wb, patches, ctx.host, { ...(seed === undefined ? {} : { seed }), ...(replayArtifact === undefined ? {} : { artifact: replayArtifact }) });
    return 'error' in r ? fail(r.error) : ok({ ...r });
  }));
}
