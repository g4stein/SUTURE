import { makeError, type CancellationToken, type CellKey, type EngineBatchOutcome, type EngineOutcome, type PyBatchEvalRequest, type PyEngine, type PyEvalRequest } from '@suture/core';

/** Spec 04 Req 6.5 — exact message shown on blocked cells. */
export const PY_BLOCKED_MESSAGE = 'Python is blocked until you trust this workbook';

/**
 * Spec 04 §6.2 — Python trust gate. While `isBlocked(cell)` is true the request resolves at once with #PY! and the inner
 * engine (and so the Pyodide worker) is never touched: no worker starts and no Pyodide bytes are downloaded.
 */
export function gatedPyEngine(inner: PyEngine, isBlocked: (cell: CellKey) => boolean): PyEngine {
  const blocked = (cell: CellKey) => makeError('#PY!', PY_BLOCKED_MESSAGE, cell, 'py');
  return {
    evaluate(req: PyEvalRequest, token: CancellationToken): Promise<EngineOutcome> {
      if (isBlocked(req.cell)) return Promise.resolve({ kind: 'value', value: blocked(req.cell) });
      return inner.evaluate(req, token);
    },
    evaluateBatch(req: PyBatchEvalRequest, token: CancellationToken): Promise<EngineBatchOutcome> {
      if (isBlocked(req.cell)) return Promise.resolve({ kind: 'values', values: req.scenarios.map(() => blocked(req.cell)) });
      return inner.evaluateBatch(req, token);
    },
  };
}
