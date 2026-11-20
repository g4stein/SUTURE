import type { CellKey } from '../model/address.ts';
import type { CellError, CellValue, ScalarValue, TableRef } from '../model/values.ts';

export interface CancellationToken {
  readonly cancelled: boolean;
  onCancel(listener: () => void): () => void;
}

export interface CancellationSource {
  readonly token: CancellationToken;
  cancel(): void;
}

export function createCancellationSource(): CancellationSource {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const token: CancellationToken = {
    get cancelled() {
      return cancelled;
    },
    onCancel(listener) {
      if (cancelled) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    token,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const l of listeners) l();
      listeners.clear();
    },
  };
}

export const NEVER_CANCELLED: CancellationToken = { cancelled: false, onCancel: () => () => undefined };

export interface Clock {
  now(): number;
}

export interface SqlTableBinding {
  readonly identifier: string;
  readonly table: TableRef;
}

export interface SqlEvalRequest {
  readonly cell: CellKey;
  readonly generation: number;
  readonly sql: string;
  readonly params: ReadonlyArray<ScalarValue>;
  readonly tables: ReadonlyArray<SqlTableBinding>;
}

export interface SqlBatchEvalRequest {
  readonly cell: CellKey;
  readonly generation: number;
  readonly sql: string;
  readonly shared: ReadonlyArray<SqlTableBinding>;
  readonly scenarios: ReadonlyArray<{
    readonly params: ReadonlyArray<ScalarValue>;
    readonly tables: ReadonlyArray<SqlTableBinding>;
  }>;
}

export interface RangeSnapshot {
  readonly kind: 'range';
  readonly rows: number;
  readonly cols: number;
  readonly values: ReadonlyArray<ScalarValue>;
}

export type PyInputValue = Exclude<CellValue, CellError> | RangeSnapshot;

export interface PyBinding {
  readonly key: string;
  readonly value: PyInputValue;
}

export interface PyEvalRequest {
  readonly cell: CellKey;
  readonly generation: number;
  readonly code: string;
  readonly vectorized: boolean;
  readonly seed: number;
  readonly inputs: ReadonlyArray<PyBinding>;
}

export interface PyBatchEvalRequest {
  readonly cell: CellKey;
  readonly generation: number;
  readonly code: string;
  readonly vectorized: boolean;
  readonly seed: number;
  readonly shared: ReadonlyArray<PyBinding>;
  readonly scenarios: ReadonlyArray<ReadonlyArray<PyBinding>>;
}

export type EngineOutcome =
  | { readonly kind: 'value'; readonly value: CellValue }
  | { readonly kind: 'cancelled' };

export type EngineBatchOutcome =
  | { readonly kind: 'values'; readonly values: ReadonlyArray<CellValue> }
  | { readonly kind: 'cancelled' };

export interface SqlEngine {
  evaluate(req: SqlEvalRequest, token: CancellationToken): Promise<EngineOutcome>;
  evaluateBatch(req: SqlBatchEvalRequest, token: CancellationToken): Promise<EngineBatchOutcome>;
}

export interface PyEngine {
  evaluate(req: PyEvalRequest, token: CancellationToken): Promise<EngineOutcome>;
  evaluateBatch(req: PyBatchEvalRequest, token: CancellationToken): Promise<EngineBatchOutcome>;
}
