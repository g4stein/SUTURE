# Requirements: WASM Worker Bridge

## Introduction

This spec defines how `packages/web` runs DuckDB-WASM and Pyodide (NumPy only) in dedicated Web Workers. It covers the typed RPC protocol between the main thread, the Exorcist worker, and the engine workers. It also covers the Arrow IPC data path from DuckDB into NumPy, timeouts, and crash recovery.

The bridge implements the `SqlEngine` and `PyEngine` ports from Spec 01 (`01-cross-engine-dag/design.md` §8.1). It obeys `.kiro/steering/architecture-and-isolation.md` and `.kiro/steering/dag-and-type-contract.md`. This document is the reference that the `spec-drift-guard` hook and the `wasm-perf-auditor` agent check against.

Glossary:
- **Engine worker**: the DuckDB worker or the Pyodide worker.
- **Ingest worker**: the worker that parses `.xlsx` files with `exceljs`.
- **Client**: a party that sends requests to an engine worker over a `MessagePort`. There are two: the main thread and the Exorcist worker.
- **Peer port**: the `MessageChannel` connecting the Pyodide worker directly to the DuckDB worker.
- **Isolated**: `crossOriginIsolated === true` and `SharedArrayBuffer` is defined.
- **Result id**: the DuckDB worker's handle for a cached query result.

## Requirements

### Requirement 1: Thread placement

**User Story:** As a user, I want the grid to stay responsive while engines work, so that heavy queries never freeze the page.

#### Acceptance Criteria
1. THE SYSTEM SHALL instantiate DuckDB-WASM only inside the DuckDB worker, and Pyodide only inside the Pyodide worker.
2. THE SYSTEM SHALL parse `.xlsx` files only inside the ingest worker.
3. THE SYSTEM SHALL NOT import `@duckdb/duckdb-wasm`, `pyodide`, or `exceljs` from any module reachable from the main-thread entry point.
4. THE SYSTEM SHALL create engine workers lazily: the DuckDB worker on the first `=SQL()` evaluation or dataset upload, or when idle after the grid is interactive; the Pyodide worker on the first permitted `=PY()` evaluation, or when idle only if the open workbook contains `=PY()` cells and its Python is trusted (Spec 04 Req 6.5).
5. THE SYSTEM SHALL create every worker (DuckDB, Pyodide, ingest, Exorcist) as a top-level dedicated worker on the main thread, SHALL NOT create a worker from inside another worker, and SHALL NOT use engine builds that spawn sub-workers (such as DuckDB's pthread bundle).

### Requirement 2: Typed RPC protocol

**User Story:** As a maintainer, I want one exact message contract, so that every client and worker agree on every field.

#### Acceptance Criteria
1. THE SYSTEM SHALL define every request, response, control, and peer message as the TypeScript unions in `design.md` §3, in the single module `packages/web/src/workers/protocol.ts`.
2. THE SYSTEM SHALL tag every message with `protocol: 1`.
3. THE SYSTEM SHALL give every request a `requestId` that is unique and strictly increasing per client port, and a `generation` that is the recalculation generation for cell-evaluation requests and `null` for lifecycle requests (init, dataset, release, ingest).
4. THE SYSTEM SHALL send exactly one terminal response (`result`) per request, or resolve it through crash recovery (Requirement 9).
5. WHEN a worker or client receives a message, THE SYSTEM SHALL validate it against the protocol with a type guard before use.
6. IF validation fails, THEN THE SYSTEM SHALL respond with `protocolError`, and SHALL surface it as `#SQL!` or `#PY!` on the requesting cell when the request can be identified.
7. THE SYSTEM SHALL let engine workers serve several client ports concurrently, scoping `requestId` per port.

### Requirement 3: Cancellation and deadlines

**User Story:** As a modeler, I want runaway queries and code stopped, so that one bad cell cannot stall the workbook.

#### Acceptance Criteria
1. THE SYSTEM SHALL accept an `AbortSignal` on the bridge API, and SHALL adapt it to the core `CancellationToken`.
2. WHEN a request is cancelled before it starts, THE SYSTEM SHALL remove it from the worker queue and respond `cancelled`.
3. WHEN a request's deadline, measured from the moment the worker reports it `started`, expires, THE SYSTEM SHALL resolve that request's cells to `#TIMEOUT!` and no others. Time spent queued never counts toward a deadline.
4. WHILE isolated, WHEN a running DuckDB query is cancelled or times out, THE SYSTEM SHALL cancel it cooperatively through the shared cancel flag, which the worker checks between result chunks, and the worker SHALL survive.
5. WHILE isolated, WHEN running Python is cancelled or times out, THE SYSTEM SHALL raise `KeyboardInterrupt` through Pyodide's interrupt buffer, and the worker SHALL survive.
6. IF a cooperative cancel does not complete within 1,000 ms (for example, a NumPy C kernel that never reaches Python's interrupt check, or a DuckDB operator that never yields a chunk), THEN THE SYSTEM SHALL terminate and respawn the worker even while isolated, resolve only that request (`#TIMEOUT!` when the escalation was caused by its deadline, `cancelled` when caused by an abort), and re-dispatch queued requests after restoring engine state.
7. WHILE not isolated, WHEN a running request times out, THE SYSTEM SHALL terminate and respawn the worker, mark only the running request's cells `#TIMEOUT!`, and re-dispatch the queued requests after restoring engine state.
8. THE SYSTEM SHALL use default deadlines of 10,000 ms for single evaluations, 60,000 ms for batch evaluations, and 120,000 ms for initialization, dataset registration, and `.xlsx` ingestion.

### Requirement 4: DuckDB lifecycle

**User Story:** As an analyst, I want DuckDB to load reliably in every browser, without nested workers.

#### Acceptance Criteria
1. WHEN the DuckDB worker initializes, THE SYSTEM SHALL load the single-threaded `eh` bundle (or `mvp` where WebAssembly exception handling is unsupported) through duckdb-wasm's synchronous bindings inside the DuckDB worker, and SHALL NOT load the pthread (COI) bundle.
2. WHEN the DuckDB worker initializes while not isolated, THE SYSTEM SHALL report the engine state `degraded` with the reason "timeouts restart the engine (page is not cross-origin isolated)", and WHILE isolated, SHALL report `ready`.
3. THE SYSTEM SHALL open the database with `castDecimalToDouble: true`, disable extension autoload and autoinstall, and install the Suture deterministic macros (`design.md` §5.4).
4. THE SYSTEM SHALL evaluate cell queries with `threads = 1`, so that results are deterministic.
5. IF the `json_serialize_sql` probe fails at initialization, THEN THE SYSTEM SHALL validate cell queries with the deterministic lexical guard (`design.md` §5.3.2), report `validator: 'lexical'` in `duckdb.ready`, and SHALL NOT fail startup.
6. WHEN initialization emits download progress, THE SYSTEM SHALL forward byte counts to clients as `progress` messages.

### Requirement 5: Datasets

**User Story:** As an analyst, I want to upload CSV, Parquet, and XLSX files and query them by name.

#### Acceptance Criteria
1. WHEN a `.csv` file is registered, THE SYSTEM SHALL ingest it with `read_csv_auto` into a table named by the sanitized dataset name.
2. WHEN a `.parquet` file is registered, THE SYSTEM SHALL ingest it with `read_parquet` into a table named by the sanitized dataset name, loading the Parquet extension lazily on the first Parquet registration (never at boot, 3 s fetch timeout). IF the extension cannot be loaded, THEN THE SYSTEM SHALL fail only that registration, with a message saying that CSV and spreadsheet imports still work.
3. WHEN an `.xlsx` file is uploaded, THE SYSTEM SHALL parse it in the ingest worker, convert each sheet to Arrow IPC, and register each as a table with `insertArrowFromIPCStream`.
4. THE SYSTEM SHALL sanitize dataset names to `^[a-z_][a-z0-9_]{0,62}$` (lowercase, non-alphanumerics replaced by `_`, a leading `_` added before a digit, `_2`, `_3`, … appended on collision).
5. WHEN registration succeeds, THE SYSTEM SHALL return `DatasetMeta` (Spec 01 §4) with the SHA-256 of the source bytes, the row count, and the schema, together with a `TableRef` preview of at most the first 100 rows.
6. IF registration fails, THEN THE SYSTEM SHALL report the DuckDB error message to the user and SHALL NOT add the dataset.
7. THE SYSTEM SHALL retain each dataset's source bytes on the main thread for as long as the dataset is registered, so that it can be restored after a worker respawn.

### Requirement 6: SQL execution

**User Story:** As an analyst, I want SQL cells to run safely and return tables or scalars without copying data needlessly.

#### Acceptance Criteria
1. THE SYSTEM SHALL validate every cell query, using the `json_serialize_sql` AST validator when available and otherwise the lexical guard, and SHALL reject with `#SQL!` anything other than exactly one read-only `SELECT`/`WITH` statement.
2. IF a query references a base table that is not a registered dataset, a binding identifier of the current request, or a CTE defined in the same query, THEN THE SYSTEM SHALL reject it with `#SQL!`.
3. IF a query calls a table function other than `range`, `generate_series`, or `unnest`, THEN THE SYSTEM SHALL reject it with `#SQL!`.
4. THE SYSTEM SHALL bind scalar parameters through prepared statements.
5. THE SYSTEM SHALL normalize and collapse results inside the DuckDB worker using the `packages/core` functions `normalizeTable` and `collapseSqlResult`.
6. WHEN a query returns a `TableRef`, THE SYSTEM SHALL post its Arrow IPC stream bytes in a buffer that the view owns entirely, list that buffer in the transfer list, and return a result id that refers to the worker's cached copy.
7. WHEN a request binds a table by result id that is still cached, THE SYSTEM SHALL use the cached copy without the client re-sending bytes.
8. IF a bound result id is not cached, THEN THE SYSTEM SHALL respond `missingTables`, and the client SHALL retry once with the table's IPC bytes attached.
9. WHEN a client releases result ids, THE SYSTEM SHALL drop the cached copies and any temporary tables materialized from them.
10. THE SYSTEM SHALL bound the result cache to 256 MiB and evict least-recently-used entries beyond that.

### Requirement 7: Pyodide lifecycle and Python execution

**User Story:** As a quant, I want NumPy to start quickly and run my code against the right inputs every time.

#### Acceptance Criteria
1. WHEN the Pyodide worker initializes, THE SYSTEM SHALL load Pyodide from the pinned `indexURL` and call `loadPackage` with `numpy` and no other package.
2. THE SYSTEM SHALL NOT load SciPy, pandas, pyarrow, or micropip.
3. WHILE isolated, THE SYSTEM SHALL register a `SharedArrayBuffer` interrupt buffer with Pyodide.
4. WHILE not isolated, THE SYSTEM SHALL report the Pyodide state `degraded` with the reason "timeouts restart the engine (page is not cross-origin isolated)".
5. THE SYSTEM SHALL run each scenario's code in a fresh namespace containing only `__builtins__`, `np`, `inputs`, and `rng`.
6. THE SYSTEM SHALL map `ZeroDivisionError` and NumPy divide-by-zero events to division evidence, `KeyboardInterrupt` to `#TIMEOUT!`, an undeclared `inputs` key to `#PY!`, and any other exception to `#PY!` with the exception type, message, and line number.
7. THE SYSTEM SHALL convert results inside the Pyodide worker per Spec 01 Requirement 4 and the steering contract, and SHALL destroy every `PyProxy` and release every `PyBuffer` before posting.

### Requirement 8: Arrow IPC into NumPy

**User Story:** As a quant, I want large tables in NumPy fast, without downloading a Python Arrow package.

#### Acceptance Criteria
1. THE SYSTEM SHALL move table bytes from the DuckDB worker to the Pyodide worker over the peer port, transferring the buffer.
2. THE SYSTEM SHALL decode Arrow IPC in the Pyodide worker's JavaScript with `apache-arrow` into typed-array views of the received buffer, without copying.
3. THE SYSTEM SHALL copy each column's data bytes from JavaScript into WebAssembly linear memory exactly once, with `JsBuffer.assign_to` into a preallocated `numpy.empty` array. The only further copy is the dtype widening of `date32` columns to `datetime64[D]`.
4. THE SYSTEM SHALL unpack Arrow validity and boolean bitmaps with `numpy.unpackbits(..., bitorder="little")`.
5. THE SYSTEM SHALL bind columns of type Float32/64, Int8/16/32/64, UInt8/16/32/64, Bool, Utf8, Date32 (day), and Timestamp (microsecond).
6. IF a bound table has a column of any other type, THEN THE SYSTEM SHALL evaluate the cell to `#PY!`, naming the column and type.
7. THE SYSTEM SHALL NOT add any Python package beyond NumPy to the cold-load path.

### Requirement 9: Crash recovery

**User Story:** As a user, I want an engine crash to cost me only the cell that caused it, and never a frozen page.

#### Acceptance Criteria
1. WHEN an engine worker posts `fatal` or raises an uncaught error, THE SYSTEM SHALL terminate it and spawn a replacement.
2. WHEN a worker crashes, THE SYSTEM SHALL resolve only the request that was running at the time with `#SQL!` (DuckDB) or `#PY!` (Pyodide), with the message `engine crashed: <reason>`.
3. WHEN a replacement worker is ready, THE SYSTEM SHALL restore engine state (datasets and macros for DuckDB, the NumPy import for Pyodide), give every client a new port, and re-send requests that were sent but not started.
4. IF a worker crashes three times within 60 seconds, THEN THE SYSTEM SHALL stop respawning it, set its state to `failed`, resolve its pending requests with `#SQL!` or `#PY!`, and offer a manual retry.
5. WHILE a worker is restarting, THE SYSTEM SHALL keep the grid interactive and show the engine state `loading`.
6. THE SYSTEM SHALL treat a WebAssembly trap, an out-of-memory failure in the WebAssembly heap, and a Pyodide fatal error as crashes, and a Python `MemoryError` as an ordinary `#PY!` result.
7. WHEN a `messageerror` event occurs, THE SYSTEM SHALL treat it as a `protocolError` and SHALL NOT terminate the worker.

### Requirement 10: Cold-load budgets

**User Story:** As a user, I want the app usable immediately and the engines ready quickly.

#### Acceptance Criteria
1. THE SYSTEM SHALL make the grid interactive without fetching any engine bytes.
2. THE SYSTEM SHALL meet these initial budgets, measured by the CI cold-load test in `design.md` §9:
   - main-thread JavaScript ≤ 350 KB gzip, excluding workers;
   - grid interactive ≤ 1.5 s;
   - DuckDB ready ≤ 4 s after the first `=SQL()`;
   - Pyodide with NumPy ready ≤ 10 s after the first `=PY()`.
3. WHEN a budget is exceeded, THE SYSTEM SHALL fail the CI cold-load test and report the measured value.
