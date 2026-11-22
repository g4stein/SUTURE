import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAAS_NOTES, saasRunwayDocument } from '@suture/runtime/workbooks';
import { callTool as call, freshSeed, StdioClient as Client, TOOLS, type Json } from './rpc.ts';

/**
 * Spec 05 Req 3 — the compiled MCP server as a child process over real stdio, driven by the hand-written JSON-RPC 2.0
 * client in `rpc.ts` (not the SDK's), so the wire format itself is under test. Both protocol eras are exercised. The audit
 * seed comes from the OS CSPRNG; the test asserts only verdicts and assertion ids.
 */
const BIN = fileURLToPath(new URL('../dist/suture-mcp.mjs', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'suture-mcp-'));
const root = join(base, 'workspace');
mkdirSync(join(root, 'models'), { recursive: true });
writeFileSync(join(root, 'models', 'runway.suture.json'), JSON.stringify(saasRunwayDocument()));
writeFileSync(join(base, 'outside.suture.json'), JSON.stringify(saasRunwayDocument()));

describe('2025-11-25: initialize handshake, tools/list, run_audit → verify_patch on Flagship 1', () => {
  const c = new Client(process.execPath, [BIN, '--root', root]);
  afterAll(() => c.close());

  beforeAll(async () => {
    const init = await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'suture-test', version: '1' } });
    expect(init.result, c.stderr).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'suture' }, capabilities: { tools: {} } });
    c.notify('notifications/initialized');
  });

  it('tools/list: exactly the four Suture tools, read-only ones annotated', async () => {
    const r = await c.request('tools/list');
    const tools = (r.result?.['tools'] as Array<{ name: string; annotations?: Json; inputSchema: Json }>) ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tools.find((t) => t.name === 'suture_verify_patch')?.inputSchema).toMatchObject({ required: expect.arrayContaining(['workbook', 'patches']) });
  });

  it('suture_list_workbooks: both flagships and the workspace file (its Python not trusted by default)', async () => {
    const r = await call(c, 'suture_list_workbooks', {});
    expect(r.isError, r.text).toBe(false);
    expect((r.structured['flagships'] as Array<{ id: string }>).map((f) => f.id)).toEqual(['flagship:1', 'flagship:2']);
    expect(r.structured['files']).toEqual([expect.objectContaining({ path: 'models/runway.suture.json', python: 'blocked', assertions: ['runway-non-negative', 'runway-defined', 'runway-finite'] })]);
  });

  it('suture_inspect_lineage: dialect, formula, precedents, dependents, and the topological chain', async () => {
    const r = await call(c, 'suture_inspect_lineage', { workbook: 'flagship:1', cell: 'Model!B5' });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured).toMatchObject({ cell: 'Model!B5', dialect: 'formula', raw: '=Inputs!B2/B4', precedents: ['Inputs!B2', 'Model!B4'], dependents: ['Model!B6'] });
    expect((r.structured['chain'] as string[]).slice(-3)).toEqual(['Model!B4', 'Model!B5', 'Model!B6']);
    expect(r.structured['dialects']).toMatchObject({ 'Cohorts!A3': 'sql', 'Model!B4': 'py' });
  });

  it('paths outside the workspace are refused', async () => {
    const r = await call(c, 'suture_inspect_lineage', { workbook: '../outside.suture.json', cell: 'Model!B5' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('outside the workspace');
  });

  it('suture_run_audit fails the unpatched flagship; suture_verify_patch passes the guarded patch with zero regressions', async () => {
    const audit = await call(c, 'suture_run_audit', { workbook: 'flagship:1', seed: freshSeed() });
    expect(audit.isError, audit.text).toBe(false);
    const a = audit.structured as { verdict: string; violation: { id: string }; failingInputs: unknown[]; lineage: Array<{ dialect: string }>; replay: { artifact: Json } };
    expect(a.verdict).toBe('violated');
    expect(a.violation.id).toBe(SAAS_NOTES.expectedAssertion);
    expect(a.failingInputs.length).toBeGreaterThan(0);
    expect(a.lineage.map((l) => l.dialect)).toEqual(expect.arrayContaining(['sql', 'py', 'formula']));

    const fixed = await call(c, 'suture_verify_patch', {
      workbook: 'flagship:1', patches: [{ cell: 'Model!B5', formula: '=IF(B4<=0,120,Inputs!B2/B4)' }], replayArtifact: a.replay.artifact,
    });
    expect(fixed.isError, fixed.text).toBe(false);
    expect(fixed.structured).toMatchObject({ ok: true, counterexampleFixed: true, freshAuditPassed: true, regressions: [], baseValueDiffs: [], seed: a.replay.artifact['seed'] });

    // A patch that changes nothing fixes nothing: the same counterexample still fails, and ok is false.
    const noop = await call(c, 'suture_verify_patch', { workbook: 'flagship:1', patches: { 'Model!B5': '=Inputs!B2/B4' }, replayArtifact: a.replay.artifact });
    expect(noop.structured).toMatchObject({ ok: false, counterexampleFixed: false, freshAuditPassed: false });
    expect(noop.structured['counterexampleStillFails']).toMatchObject({ id: SAAS_NOTES.expectedAssertion });
    expect(c.noise).toEqual([]);
  });
});

describe('2026-07-28: stateless server/discover and per-request _meta', () => {
  const c = new Client(process.execPath, [BIN, '--root', root]);
  afterAll(() => c.close());
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'suture-test', version: '1' } };

  it('server/discover, tools/list, and tools/call work without an initialize handshake', async () => {
    const d = await c.request('server/discover', { _meta: meta });
    expect(d.result, c.stderr).toMatchObject({ supportedVersions: expect.arrayContaining(['2026-07-28']), capabilities: { tools: {} } });
    const list = await c.request('tools/list', { _meta: meta });
    expect(((list.result?.['tools'] as Array<{ name: string }>) ?? []).map((t) => t.name).sort()).toEqual(TOOLS);
    const r = await call(c, 'suture_inspect_lineage', { workbook: 'models/runway.suture.json', cell: 'Model!B4' }, meta);
    expect(r.isError, r.text).toBe(false);
    expect(r.result['resultType']).toBe('complete');
    expect(r.structured).toMatchObject({ dialect: 'py', workbook: { python: 'blocked' } });
    expect(c.noise).toEqual([]);
  });
});
