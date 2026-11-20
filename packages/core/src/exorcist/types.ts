import type { CellKey } from '../model/address.ts';
import type { CellErrorCode, EngineId, ScalarValue } from '../model/values.ts';
import type { WorkbookDefinition } from '../model/workbook.ts';

export type UniversalInvariantId =
  | 'T1.noUnhandledException'
  | 'T1.noNonFiniteLeak'
  | 'T1.strictErrorPropagation'
  | 'T1.editOrderDeterminism'
  | 'T1.crossEngineTolerance';

export type FuzzDomain =
  | { readonly kind: 'float'; readonly min: number; readonly max: number }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'choice'; readonly values: ReadonlyArray<ScalarValue> }
  | { readonly kind: 'boolean' };

export interface FuzzInput {
  readonly cell: CellKey;
  readonly domain: FuzzDomain;
}

export type AssertionOperand =
  | { readonly kind: 'const'; readonly value: number }
  | { readonly kind: 'cell'; readonly cell: CellKey };

interface AssertionBase {
  readonly id: string;
  readonly cell: CellKey;
}

export type CellAssertion =
  | (AssertionBase & { readonly kind: 'gte' | 'lte' | 'gt' | 'lt'; readonly operand: AssertionOperand })
  | (AssertionBase & { readonly kind: 'between'; readonly min: AssertionOperand; readonly max: AssertionOperand })
  | (AssertionBase & { readonly kind: 'notError' })
  | (AssertionBase & { readonly kind: 'finite' })
  | (AssertionBase & { readonly kind: 'notNull' })
  | (AssertionBase & { readonly kind: 'monotonicWith'; readonly input: CellKey; readonly direction: 'nonDecreasing' | 'nonIncreasing' });

export interface ExorcistConfig {
  readonly inputs: ReadonlyArray<FuzzInput>;
  readonly assertions: ReadonlyArray<CellAssertion>;
  readonly numRuns: number;
  readonly batchSize: number;
  readonly maxBatches: number;
  readonly maxShrinkRounds: number;
}

export interface SutureDocument {
  readonly format: 'suture.workbook';
  readonly version: 1;
  readonly title: string;
  readonly workbook: WorkbookDefinition;
  readonly exorcist: ExorcistConfig;
}

export type ExecutionMode = 'inProcess' | 'batched';

/** Exact, JSON-safe scalar. Numbers keep -0 and every bit via String(n) / "-0". */
export type EncodedScalar =
  | { readonly t: 'n'; readonly v: string }
  | { readonly t: 's'; readonly v: string }
  | { readonly t: 'b'; readonly v: boolean }
  | { readonly t: 'z' };

export type ValueSummary =
  | { readonly kind: 'scalar'; readonly value: EncodedScalar }
  | { readonly kind: 'error'; readonly code: CellErrorCode; readonly origin: CellKey; readonly engine: EngineId; readonly message: string }
  | { readonly kind: 'matrix'; readonly rows: number; readonly cols: number }
  | { readonly kind: 'table'; readonly rowCount: number; readonly columns: ReadonlyArray<string> };

export type ViolatedAssertion =
  | { readonly tier: 1; readonly invariant: UniversalInvariantId; readonly cell: CellKey | null; readonly detail: string }
  | { readonly tier: 2; readonly assertion: CellAssertion; readonly observed: ValueSummary; readonly paired: ValueSummary | null; readonly detail: string };

export interface LineageEdge {
  readonly from: CellKey;
  readonly to: CellKey;
}

export interface LineagePath {
  readonly cells: ReadonlyArray<CellKey>;
  readonly edges: ReadonlyArray<LineageEdge>;
  readonly failingEdge: LineageEdge | null;
}

export interface ReplayArtifact {
  readonly format: 'suture.replay';
  readonly version: 1;
  readonly mode: ExecutionMode;
  readonly seed: number;
  readonly path: string;
  readonly numRuns: number;
  readonly batchSize: number;
  readonly failingInputs: ReadonlyArray<{ readonly cell: CellKey; readonly value: EncodedScalar }>;
  readonly violatedAssertion: ViolatedAssertion;
  readonly lineagePath: LineagePath;
  readonly workbookHash: string;
  readonly sutureVersion: string;
  readonly fastCheckVersion: string;
  readonly createdAt: string;
}

export type ExorcistVerdict =
  | { readonly kind: 'passed'; readonly runs: number; readonly scenarios: number; readonly durationMs: number }
  | { readonly kind: 'violated'; readonly artifact: ReplayArtifact }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'configError'; readonly message: string };

export interface ExorcistProgress {
  readonly phase: 'search' | 'shrink' | 'confirm';
  readonly mode: ExecutionMode;
  readonly runs: number;
  readonly scenarios: number;
  readonly shrinkRounds: number;
}

export interface Hasher {
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface Compressor {
  deflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
  inflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
}

export const DEFAULT_EXORCIST: Omit<ExorcistConfig, 'inputs' | 'assertions'> = {
  numRuns: 1000,
  batchSize: 200,
  maxBatches: 10,
  maxShrinkRounds: 64,
};
