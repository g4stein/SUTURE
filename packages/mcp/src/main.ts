import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SUTURE_VERSION } from '@suture/runtime/bridge';
import { createNodeHeadless } from '@suture/runtime/node';
import { registerTools } from './tools.ts';

/**
 * `suture-mcp` — local Model Context Protocol server over stdio (Spec 05 Req 3). Serves both protocol eras: the stateless
 * 2026-07-28 revision (`server/discover`, per-request `_meta`) and the 2025-11-25 `initialize` handshake. stdout carries
 * only JSON-RPC; every log line goes to stderr.
 */
console.log = (...args: unknown[]): void => console.error(...args);
console.info = console.log;

const { values } = parseArgs({ args: process.argv.slice(2), options: { root: { type: 'string' } }, strict: true });
const root = resolve(values.root ?? process.env['SUTURE_WORKSPACE'] ?? process.cwd());
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`suture-mcp: workspace root ${root} is not a directory`);
  process.exit(2);
}

const { host } = createNodeHeadless();
const make = (): McpServer => {
  const server = new McpServer(
    { name: 'suture', version: SUTURE_VERSION },
    { instructions: 'Suture audits cross-engine spreadsheet models (formulas, DuckDB SQL, Python/NumPy) locally. Start with suture_list_workbooks; suture_run_audit finds counterexamples; suture_verify_patch checks a fix in memory before you edit any file.' },
  );
  registerTools(server, { host, root });
  return server;
};

serveStdio(make, { onerror: (e) => console.error(`suture-mcp: ${e.message}`) });
console.error(`suture-mcp ${SUTURE_VERSION}: serving on stdio, workspace ${root}`);
