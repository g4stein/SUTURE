import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createCancellationSource } from '@suture/core';
import { SUTURE_VERSION } from '@suture/runtime/bridge';
import { auditWorkbook, evaluateWorkbook, flagshipForHash, inspectLineage, replayWorkbook } from '@suture/runtime/headless';
import { createNodeHeadless, loadReplayArtifact, loadWorkbook } from '@suture/runtime/node';
import { auditText, evalText, inspectText, replayText } from './print.ts';

/**
 * `suture` — the headless audit CLI (Spec 05 Req 2). Every command runs the same real-engine code path as the web app
 * (`@suture/runtime`), in-process. Exit codes are CI-friendly: 0 pass, 1 finding, 2 input or runtime error.
 */
const USAGE = `suture ${SUTURE_VERSION} — headless audit CLI for Suture workbooks

Usage:
  suture eval    <workbook> [--json] [--trust-python]
  suture audit   <workbook> [--seed <n>] [--json] [--out-replay <file>] [--trust-python]
  suture replay  <replay.json> [--workbook <workbook>] [--json] [--trust-python]
  suture inspect <workbook> --cell <Sheet!A1> [--json]

<workbook> is flagship:1, flagship:2, or a path to a .suture.json file.

Exit codes:
  eval     0 evaluated · 2 error
  audit    0 every invariant and assertion held · 1 violation found · 2 configuration, input, or runtime error · 130 interrupted
  replay   0 reproduced exactly · 1 reproduced only directly, or not reproduced · 2 wrong workbook (hash mismatch) or error
  inspect  0 · 2 error

Python in a .suture.json file runs only with --trust-python. Under Node, Python code can reach the file system and the
network through Pyodide's JavaScript bridge, so trust only workbooks you would run as a script. The built-in flagships
always run.
`;

class UsageError extends Error {}

type Out = { readonly text: string; readonly code: number };

/** `--seed -42` is ambiguous to `parseArgs` (it looks like a flag); a negative integer after `--seed` is its value. */
function joinNegativeSeed(argv: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = argv[i + 1];
    if (a === '--seed' && next !== undefined && /^-\d+$/.test(next)) {
      out.push(`--seed=${next}`);
      i++;
    } else out.push(a);
  }
  return out;
}

async function run(argv: ReadonlyArray<string>): Promise<Out> {
  const { values, positionals } = parseArgs({
    args: joinNegativeSeed(argv),
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean', default: false },
      'trust-python': { type: 'boolean', default: false },
      seed: { type: 'string' },
      'out-replay': { type: 'string' },
      workbook: { type: 'string' },
      cell: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) return { text: `${SUTURE_VERSION}\n`, code: 0 };
  const [command, target, ...extra] = positionals;
  if (values.help || command === undefined || command === 'help') return { text: USAGE, code: command === undefined && !values.help ? 2 : 0 };
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0] ?? ''}"`);
  if (target === undefined) throw new UsageError(`${command}: missing ${command === 'replay' ? '<replay.json>' : '<workbook>'}`);
  const json = values.json;
  const emit = (report: unknown, text: string, code: number): Out => ({ text: json ? `${JSON.stringify(report, null, 2)}\n` : text, code });
  const { host } = createNodeHeadless();
  const load = { trustPython: values['trust-python'], base: process.cwd(), root: null };

  switch (command) {
    case 'eval': {
      const wb = await loadWorkbook(target, load, host);
      if ('error' in wb) throw new UsageError(wb.error);
      const r = await evaluateWorkbook(wb, host);
      return emit(r, evalText(r), 0);
    }
    case 'audit': {
      let seed: number | undefined;
      if (values.seed !== undefined) {
        seed = Number(values.seed);
        if (!/^-?\d+$/.test(values.seed) || seed < -2147483648 || seed > 4294967295) throw new UsageError(`--seed must be an integer between -2147483648 and 4294967295, not "${values.seed}"`);
      }
      const wb = await loadWorkbook(target, load, host);
      if ('error' in wb) throw new UsageError(wb.error);
      const cancel = createCancellationSource();
      const onSigint = (): void => {
        if (cancel.token.cancelled) process.exit(130);
        cancel.cancel();
      };
      process.on('SIGINT', onSigint);
      const r = await auditWorkbook(wb, host, { ...(seed === undefined ? {} : { seed }), token: cancel.token });
      process.off('SIGINT', onSigint);
      const outFile = values['out-replay'] ?? null;
      if (outFile !== null && r.replay !== null) writeFileSync(resolve(outFile), `${JSON.stringify(r.replay.artifact, null, 2)}\n`);
      const code = r.verdict === 'passed' ? 0 : r.verdict === 'violated' ? 1 : r.verdict === 'stopped' ? 130 : 2;
      return emit(r, auditText(r, outFile !== null && r.replay !== null ? outFile : null), code);
    }
    case 'replay': {
      const artifact = loadReplayArtifact(target, { base: process.cwd(), root: null });
      if ('error' in artifact) throw new UsageError(artifact.error);
      let wb;
      if (values.workbook !== undefined) {
        wb = await loadWorkbook(values.workbook, load, host);
        if ('error' in wb) throw new UsageError(wb.error);
      } else {
        const found = await flagshipForHash(artifact.workbookHash, host);
        if (found === null) throw new UsageError(`the artifact was recorded on workbook ${artifact.workbookHash}, which is not a built-in flagship: pass --workbook <file.suture.json>`);
        wb = found.workbook;
      }
      const r = await replayWorkbook(wb, artifact, host);
      if ('error' in r) throw new UsageError(r.error);
      const code = r.outcome === 'exact' ? 0 : r.outcome === 'hashMismatch' ? 2 : 1;
      return emit(r, replayText(r), code);
    }
    case 'inspect': {
      if (values.cell === undefined) throw new UsageError('inspect: missing --cell <Sheet!A1>');
      const wb = await loadWorkbook(target, load, host);
      if ('error' in wb) throw new UsageError(wb.error);
      const r = inspectLineage(wb, values.cell, host);
      if ('error' in r) throw new UsageError(r.error);
      return emit(r, inspectText(r), 0);
    }
    default:
      throw new UsageError(`unknown command "${command}" (eval, audit, replay, inspect)`);
  }
}

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolveWrite) => {
    if (text === '') resolveWrite();
    else stream.write(text, () => resolveWrite());
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  let out: Out;
  try {
    out = await run(argv);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const usage = e instanceof UsageError || (e instanceof TypeError && 'code' in e && typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS'));
    await write(process.stderr, `suture: ${usage ? '' : 'runtime error: '}${message}\n`);
    out = { text: json ? `${JSON.stringify({ format: 'suture.error', version: 1, error: message }, null, 2)}\n` : '', code: 2 };
  }
  await write(process.stdout, out.text);
  // The engines keep handles open (Pyodide, DuckDB); the command is done, so exit explicitly.
  process.exit(out.code);
}

void main();
