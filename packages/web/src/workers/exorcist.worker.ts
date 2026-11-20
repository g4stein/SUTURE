import {
  createCancellationSource, createExorcistSession, toReplayFragment,
  type CancellationSource, type ExorcistDeps, type PyEngine, type SqlEngine,
} from '@suture/core';
import { isExorcistCommand, type ExorcistCommand, type ExorcistEvent } from './exorcistProtocol.ts';
import { PyBridge, SqlBridge } from './bridges.ts';
import { PortClient } from './portClient.ts';
import { scope } from './workerRuntime.ts';
import { webClock, webCompressor, webHasher, yieldControl } from '../engines/hostAdapters.ts';
import type { EngineName } from './protocol.ts';

const FAST_CHECK_VERSION = '4.10.3';
const SUTURE_VERSION = '0.1.0';

const clients: Record<EngineName, PortClient | null> = { duckdb: null, pyodide: null };
const sessions = new Map<number, CancellationSource>();

function post(e: ExorcistEvent): void {
  scope.postMessage(e);
}

function unavailable(engine: string): Promise<never> {
  return Promise.reject(new Error(`${engine} is not available to this Exorcist session`));
}

function client(engine: EngineName): Promise<PortClient> {
  const c = clients[engine];
  return c === null ? unavailable(engine) : Promise.resolve(c);
}

function connect(cmd: Extract<ExorcistCommand, { kind: 'start' | 'replay' }>): void {
  const mk = (engine: EngineName, port: MessagePort | null, portId: number | null, buffer: SharedArrayBuffer | null): PortClient | null => {
    if (port === null || portId === null) return null;
    return new PortClient(port, {
      portId, engine, isolation: cmd.isolation, control: buffer === null ? null : new Int32Array(buffer),
      onRespawnNeeded: (requestId, cause) => post({ protocol: 1, kind: 'respawnRequest', engine, portId, requestId, cause }),
    });
  };
  clients.duckdb = mk('duckdb', cmd.duckdbPort, cmd.duckdbPortId, cmd.duckdbCancelBuffer);
  clients.pyodide = mk('pyodide', cmd.pyodidePort, cmd.pyodidePortId, cmd.interruptBuffer);
}

function deps(): ExorcistDeps {
  const sql: SqlEngine = new SqlBridge(() => client('duckdb'), 'background');
  const py: PyEngine = new PyBridge(() => client('pyodide'), 'background');
  return {
    engine: { sql, py, clock: webClock, yieldControl },
    hasher: webHasher,
    compressor: webCompressor,
    versions: { suture: SUTURE_VERSION, fastCheck: FAST_CHECK_VERSION },
  };
}

async function onCommand(cmd: ExorcistCommand): Promise<void> {
  if (cmd.kind === 'stop') {
    sessions.get(cmd.sessionId)?.cancel();
    return;
  }
  if (cmd.kind === 'enginePortReplaced') {
    clients[cmd.engine]?.replacePort(cmd.port, cmd.runningRequestId, cmd.cause, cmd.reason);
    return;
  }
  connect(cmd);
  const source = createCancellationSource();
  sessions.set(cmd.sessionId, source);
  try {
    const s = await createExorcistSession(cmd.document, deps());
    if ('configError' in s) {
      post({ protocol: 1, kind: 'verdict', sessionId: cmd.sessionId, verdict: { kind: 'configError', message: s.configError }, fragment: null });
      return;
    }
    if (cmd.kind === 'replay') {
      const outcome = await s.replay(cmd.artifact, source.token);
      post({ protocol: 1, kind: 'replayed', sessionId: cmd.sessionId, outcome });
      return;
    }
    const verdict = await s.run({
      seed: cmd.seed, token: source.token,
      onProgress: (progress) => post({ protocol: 1, kind: 'progress', sessionId: cmd.sessionId, progress }),
    });
    let fragment: string | null = null;
    if (verdict.kind === 'violated') {
      const f = await toReplayFragment(verdict.artifact, webCompressor);
      fragment = typeof f === 'string' ? f : null;
    }
    post({ protocol: 1, kind: 'verdict', sessionId: cmd.sessionId, verdict, fragment });
  } catch (e) {
    post({ protocol: 1, kind: 'failure', sessionId: cmd.sessionId, message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  } finally {
    sessions.delete(cmd.sessionId);
  }
}

scope.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (isExorcistCommand(e.data)) void onCommand(e.data);
});
