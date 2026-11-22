import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * A minimal JSON-RPC 2.0 client over a child process's stdio, written here rather than taken from the MCP SDK, so the
 * wire format itself is under test. Used by the stdio tests and by the packed-tarball smoke test.
 */
export type Json = Record<string, unknown>;
export interface RpcMessage { readonly jsonrpc: '2.0'; readonly id?: number; readonly method?: string; readonly result?: Json; readonly error?: Json }

export class StdioClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (m: RpcMessage) => void>();
  /** Every stdout line must be a JSON-RPC message; anything else would corrupt the stream for a real client. */
  readonly noise: string[] = [];
  stderr = '';

  constructor(command: string, args: ReadonlyArray<string>, cwd?: string) {
    this.proc = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }) });
    this.proc.stderr.on('data', (d: Buffer) => { this.stderr += d.toString(); });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line === '') continue;
        let m: RpcMessage;
        try {
          m = JSON.parse(line) as RpcMessage;
        } catch {
          this.noise.push(line);
          continue;
        }
        if (m.jsonrpc !== '2.0') this.noise.push(line);
        if (typeof m.id === 'number') this.waiting.get(m.id)?.(m);
      }
    });
  }

  request(method: string, params: Json = {}): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Json = {}): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

export async function callTool(c: StdioClient, name: string, args: Json, meta?: Json): Promise<{ readonly structured: Json; readonly isError: boolean; readonly text: string; readonly result: Json }> {
  const r = await c.request('tools/call', { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
  if (r.error !== undefined) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(r.error)}`);
  const result = r.result ?? {};
  const content = (result['content'] as Array<{ type: string; text: string }> | undefined) ?? [];
  return { structured: (result['structuredContent'] as Json | undefined) ?? {}, isError: result['isError'] === true, text: content.map((x) => x.text).join('\n'), result };
}

export const TOOLS = ['suture_inspect_lineage', 'suture_list_workbooks', 'suture_run_audit', 'suture_verify_patch'];
export const freshSeed = (): number => crypto.getRandomValues(new Int32Array(1))[0] ?? 1;
