# Requirements: Exorcist PBT Fuzzer

## Introduction

The Exorcist is Suture's live property-based tester. It generates input scenarios for declared fuzz inputs, evaluates the workbook under each scenario, and checks two tiers of invariants. When an invariant fails, it shrinks the failing scenario to a minimal counterexample and records a replay artifact that anyone can open from a link.

The logic lives in `packages/core/src/exorcist/` (isomorphic, built on `fast-check`). In the browser it runs in a dedicated Exorcist worker, which reaches DuckDB and Pyodide through the client ports defined in Spec 02.

It uses these Spec 01 types unchanged: `CellKey`, `CellValue`, `CellError`, `CellErrorCode`, `EngineId`, `ScalarValue`, `TableRef`, `Matrix2D`, `Edit`, `WorkbookDefinition`, `WorkbookEngine`, `EngineDeps`, `EngineEvent`, `ScenarioOverrides`, `ScenarioBatch`, `ScenarioBatchResult`, `TieBreak`, `CancellationToken`, `SqlBatchEvalRequest`, `PyBatchEvalRequest`. Only the web host (`packages/web`, never `packages/core`) uses these Spec 02 types: `EngineName`, `IsolationInfo`, `PortClient`, `EngineHost`.

Glossary:
- **Fuzz input**: a literal cell with a declared domain that the Exorcist varies.
- **Scenario**: one assignment of values to all fuzz inputs.
- **Run**: one generated scenario plus its paired scenarios for monotonicity checks.
- **In-process mode**: every cell between the fuzz inputs and the asserted cells is a literal or formula cell.
- **Batched mode**: that subgraph contains at least one `=SQL()` or `=PY()` cell.

## Requirements

### Requirement 1: Configuration

**User Story:** As a modeler, I want to declare what to vary and what must hold, so that the Exorcist tests my real concerns.

#### Acceptance Criteria
1. THE SYSTEM SHALL store fuzz inputs and cell assertions in the workbook document (`SutureDocument.exorcist`).
2. THE SYSTEM SHALL support the fuzz domains `float` (finite `min ≤ max`), `integer` (safe integers, `min ≤ max`), `choice` (a non-empty list of scalars), and `boolean`.
3. IF a fuzz input targets a cell that is not a literal cell, has a domain with `min > max`, or has non-finite bounds, THEN THE SYSTEM SHALL refuse to start and report a configuration error that names the cell.
4. IF an assertion references a cell that does not exist, THEN THE SYSTEM SHALL refuse to start and report a configuration error that names the assertion.
5. THE SYSTEM SHALL default to 1,000 runs in in-process mode, and to a batch size of 200 runs and at most 10 batches in batched mode. A run's scenario count is 1 plus one paired scenario per applicable `monotonicWith` assertion.
6. IF the configured batch size is outside 100–200, THEN THE SYSTEM SHALL refuse to start with a configuration error.

### Requirement 2: Tier 1 universal invariants

**User Story:** As an auditor, I want engine-level guarantees checked on every run, so that platform bugs surface before model bugs.

#### Acceptance Criteria
1. THE SYSTEM SHALL check all Tier 1 invariants on every run, whether or not the user declared any assertions.
2. IF evaluating a scenario throws, or the engine reports an internal kernel exception, THEN THE SYSTEM SHALL report a `T1.noUnhandledException` violation.
3. IF any value in the evaluated subgraph fails `assertCanonical`, THEN THE SYSTEM SHALL report a `T1.noNonFiniteLeak` violation.
4. IF a formula cell without `IFERROR` or `ISERROR` has an error-valued reference or error literal and its value is not a `CellError`, or its value is an upstream error that is not the first error-valued leaf in source order, THEN THE SYSTEM SHALL report a `T1.strictErrorPropagation` violation.
5. IF an engine cell has an error-valued input and its value is not the first such error in order of appearance, THEN THE SYSTEM SHALL report a `T1.strictErrorPropagation` violation.
6. WHEN the run index is a multiple of 10, THE SYSTEM SHALL re-evaluate the scenario with a `seeded` tie-break, and IF any value differs bit for bit, THEN THE SYSTEM SHALL report a `T1.editOrderDeterminism` violation.
7. WHEN the run index is a multiple of 50, THE SYSTEM SHALL apply the scenario's overrides as `setLiteral` edits, in a seeded random permutation, to a fresh engine built from the document, and IF any value differs bit for bit from the scenario evaluation, THEN THE SYSTEM SHALL report a `T1.editOrderDeterminism` violation.
8. WHILE in batched mode, THE SYSTEM SHALL compute `sum`, `mean`, `min`, `max`, and `count` probes for every all-numeric range and every numeric `TableRef` column bound into an engine cell, in every engine that can compute them, and IF two engines disagree beyond `|a − b| ≤ max(1e-12, 1e-9 · max(|a|, |b|))` (or `count` differs at all), THEN THE SYSTEM SHALL report a `T1.crossEngineTolerance` violation.
9. THE SYSTEM SHALL require bit-identical values within one engine, and SHALL apply the tolerance in 2.8 only to comparisons across engines.

### Requirement 3: Tier 2 cell assertions

**User Story:** As a modeler, I want to state business rules on cells, so that the Exorcist hunts for inputs that break them.

#### Acceptance Criteria
1. THE SYSTEM SHALL support the assertions `gte`, `lte`, `gt`, `lt` (operand: a constant or a cell), `between` (inclusive; operands as before), `notError`, `finite`, `notNull`, and `monotonicWith(input, direction)`.
2. WHEN a comparison or `between` assertion is checked, THE SYSTEM SHALL pass a number that satisfies it, pass a `Matrix2D` only if every element satisfies it, and fail every other value, including errors, `null`, strings, booleans, and `TableRef`s.
3. WHEN `notError` is checked, THE SYSTEM SHALL fail any `CellError`.
4. WHEN `finite` is checked, THE SYSTEM SHALL pass a number, a `Matrix2D`, or a `TableRef` whose numeric columns contain no nulls, and fail everything else.
5. WHEN `notNull` is checked, THE SYSTEM SHALL fail `null`, and fail a `TableRef` that has any null in any column.
6. WHEN `monotonicWith(input, direction)` is checked, THE SYSTEM SHALL evaluate the scenario together with a paired scenario in which only `input` is increased by a generated positive step within its domain, and SHALL fail when both values are numbers and their order violates `direction`.
7. IF either value of a monotonic pair is not a number, THEN THE SYSTEM SHALL skip that pair for this assertion.
8. IF the monotonic `input` is not a declared fuzz input with a `float` or `integer` domain, THEN THE SYSTEM SHALL refuse to start with a configuration error.

### Requirement 4: In-process mode

**User Story:** As a modeler, I want instant feedback on pure formula models.

#### Acceptance Criteria
1. WHEN no `=SQL()` or `=PY()` cell lies between the fuzz inputs and the cells referenced by assertions, THE SYSTEM SHALL run in in-process mode using `fc.assert` with an async property over `WorkbookEngine.evaluateScenarioBatch`.
2. THE SYSTEM SHALL complete 1,000 runs of the reference passing workbook (design §10) in under 2 seconds in CI on Node.
3. THE SYSTEM SHALL complete search and shrinking for the reference failing workbook (design §10) in under 2 seconds in CI on Node.
4. WHEN a run fails, THE SYSTEM SHALL use fast-check's shrinking, then apply the deterministic decimal simplification (design §4.6), to produce the minimal counterexample.

### Requirement 5: Batched mode

**User Story:** As an analyst, I want cross-engine models fuzzed without one worker round-trip per scenario.

#### Acceptance Criteria
1. WHEN the subgraph contains an engine cell, THE SYSTEM SHALL generate runs in batches of the configured size and evaluate all scenarios of a batch's runs with one `evaluateScenarioBatch` call, which makes at most one engine request per engine cell plus at most one probe request per engine.
2. THE SYSTEM SHALL generate scenarios from `fc.Random` seeded with the session seed via `pure-rand` `xoroshiro128plus`, using each arbitrary's `generate(mrng, bias)` with `bias = 2 + floor(log10(i + 1))` for scenario index `i`.
3. WHEN a batch contains failing scenarios, THE SYSTEM SHALL select the failing scenario with the lowest index, and shrink it by taking up to `batchSize` candidates at a time from `arbitrary.shrink(value, context)`, evaluating each chunk in one batch, accepting the lowest-index failing candidate, and repeating until the stream is exhausted or 64 rounds have run.
4. THE SYSTEM SHALL record the shrink as a candidate path `"<scenarioIndex>:<k1>:<k2>:…"`, where each `k` is the accepted candidate's index within that round's shrink stream.
5. WHEN shrinking finishes, THE SYSTEM SHALL confirm the counterexample by evaluating it alone (batch size 1), and IF confirmation does not reproduce the violation, THEN THE SYSTEM SHALL report a `T1.editOrderDeterminism` violation describing the batch/single mismatch.
6. IF an engine worker crashes during a batch, THEN THE SYSTEM SHALL bisect the batch (evaluating both halves, lower half first, and recursing into each half that crashes) until it isolates every crashing scenario, using at most 2·⌈log₂ S⌉ extra calls for one crashing scenario among S, and SHALL treat the resulting `#SQL!` or `#PY!` values as ordinary values.

### Requirement 6: Results and lineage

**User Story:** As a modeler, I want to see exactly which inputs and cells led to the failure.

#### Acceptance Criteria
1. WHEN a violation is confirmed, THE SYSTEM SHALL compute the lineage: the cells on any dependency path from the changed inputs (fuzz inputs whose counterexample value differs from the workbook value under `Object.is`) to the violating cell, with all fuzz inputs used when none changed.
2. THE SYSTEM SHALL identify the failing edge: the lineage edge into the first cell, in topological order, whose counterexample value is a `CellError` or violates the assertion.
3. THE SYSTEM SHALL stop the session at the first confirmed violation and report exactly one artifact.
4. WHEN no violation is found within the run or batch limit, THE SYSTEM SHALL report a `passed` verdict with run count, scenario count, and duration.
5. THE SYSTEM SHALL emit progress events at least every 250 ms while running.

### Requirement 7: Replay artifact

**User Story:** As a reviewer, I want to click a link and see the exact bug, so that findings are verifiable.

#### Acceptance Criteria
1. THE SYSTEM SHALL serialize every confirmed violation as a `ReplayArtifact` containing at least `seed`, `path`, `failingInputs`, `violatedAssertion`, `lineagePath`, and `workbookHash`, plus `mode`, `batchSize`, `numRuns`, `sutureVersion`, and `fastCheckVersion`.
2. THE SYSTEM SHALL compute `workbookHash` as `sha256:` plus the lowercase hex SHA-256 of the canonical JSON of the document's `workbook` and `exorcist` fields.
3. THE SYSTEM SHALL offer the artifact as a downloadable `.suture-replay.json` file of canonical JSON.
4. THE SYSTEM SHALL encode the artifact as a URL fragment `#replay=v1.<base64url(deflate-raw(UTF-8 canonical JSON))>`.
5. IF the encoded fragment would exceed 8,192 characters, THEN THE SYSTEM SHALL offer only the file download, and say why.
6. WHEN a replay is opened and the loaded document's hash equals `workbookHash`, THE SYSTEM SHALL regenerate the counterexample from `seed` and `path`, verify that it equals `failingInputs`, evaluate it, and show the violation.
7. IF the regenerated inputs differ from `failingInputs` (for example, different `fastCheckVersion`), THEN THE SYSTEM SHALL evaluate `failingInputs` directly, and label the replay "direct".
8. IF `workbookHash` does not match the loaded document, THEN THE SYSTEM SHALL refuse to replay and show both hashes.
9. THE SYSTEM SHALL produce an identical artifact, apart from `createdAt`, for the same document, seed, and configuration.
10. THE SYSTEM SHALL preserve `-0` and every other number exactly in `failingInputs`.

### Requirement 8: Isolation from the UI

**User Story:** As a user, I want fuzzing never to slow down my editing.

#### Acceptance Criteria
1. THE SYSTEM SHALL run Exorcist sessions in a dedicated Exorcist worker, with its own `WorkbookEngine` built from a snapshot of the document.
2. THE SYSTEM SHALL send Exorcist engine requests with priority `background`.
3. WHEN the user edits the workbook during a session, THE SYSTEM SHALL keep the running session on its snapshot, and SHALL mark its result as "stale" if the document hash changed.
4. WHEN the user stops a session, THE SYSTEM SHALL cancel its in-flight engine requests within 1,000 ms.
