# Tasks: WASM Worker Bridge

Unit tests run with `npx vitest --run` in `packages/web`. Browser tests run with Playwright (Chromium, plus WebKit where a task says so). Do not use watch mode.

- [ ] 1. Protocol
  - [ ] 1.1 Implement `workers/protocol.ts` exactly per design §3, with exhaustive type guards and `transferListOf`.
    - Verify: for every message variant, a guard test accepts a valid instance and rejects instances that are each missing one field or have one field of the wrong type. A `never`-check test fails to compile when a variant is added without a guard.
    - _Requirements: 2.1, 2.2, 2.5_
  - [ ] 1.2 Implement `owned` / `ownedF64` and use them in `transferListOf`.
    - Verify: a view into a larger buffer is sliced; a whole-buffer view is returned as is; after `postMessage` the sender's buffer has `byteLength === 0` (detached).
    - _Requirements: 6.6, 8.1_

- [ ] 2. PortClient and core port adapters
  - [ ] 2.1 Implement `PortClient`: requestIds strictly increasing per port, correlation, deadline timers from an injected clock, `cancel` control messages, `tokenFromSignal` / `signalFromToken`.
    - Verify: a test over a real `MessageChannel` with an echo worker script checks the request→`started`→`result` order, out-of-order responses resolving the correct promises, an abort before start → `cancelled`, and deadline expiry → `#TIMEOUT!`.
    - _Requirements: 2.3, 2.4, 3.1, 3.2, 3.3_
  - [ ] 2.2 Implement `SqlBridge` and `PyBridge` (core `SqlEngine` / `PyEngine`) with the `WeakMap<TableRef, ResultId>` and the single `missingTables` retry.
    - Verify: a cached `TableRef` is sent as `{kind:'result'}`; after an epoch change, `missingTables` triggers exactly one resend with `{kind:'ipc'}`; ports never reject.
    - _Requirements: 6.7, 6.8_

- [ ] 3. Worker job queue
  - [ ] 3.1 Implement the shared queue (priority, FIFO, start-on-fresh-tick) used by both engine workers.
    - Verify: a `cancel` posted right after a request (before the tick) prevents the job from starting; `interactive` jobs overtake queued `background` jobs.
    - _Requirements: 3.2, 2.7_

- [ ] 4. DuckDB worker
  - [ ] 4.1 Implement init: bundle selection by isolation, the nested worker via Blob URL, `castDecimalToDouble`, the `SET`s, and the `json_serialize_sql` probe.
    - Verify: Playwright on a page served with COOP/COEP reports `coi` and `ready`; without the headers it reports `eh`/`mvp` and `degraded` with the exact reason string.
    - _Requirements: 4.1–4.6_
  - [ ] 4.2 Install the deterministic macros.
    - Verify: a known-answer test shows `suture_h32(x)` equals core's lowbias32 finalizer for x in 0..9999; `suture_u01` lies in [0,1) over 100,000 values.
    - _Requirements: 4.3_
  - [ ] 4.3 Implement `validateSerializedSql`.
    - Verify: a table test accepts `SELECT`, CTEs, `range()`, dataset names, and `__suture_b0`; it rejects `CREATE`, `COPY`, `ATTACH`, `PRAGMA`, `SET`, two statements, `FROM 'x.csv'`, `FROM 'https://…'`, `read_csv(...)`, `__res_*`, an unbound `__suture_b1`, and `other_catalog.t`.
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ] 4.4 Implement query and queryBatch: prepared statements, bindings and views, streaming `send`, IPC encoding, the result cache with LRU, core normalization/collapse in-worker, and `releaseResults`.
    - Verify: `SELECT 1/0.0` gives `#NUM!` or `null` as the steering rules require; `SELECT 42` gives the scalar `42`; a 100k-row result arrives with its buffer transferred; queryBatch over 200 param sets returns 200 values in one response; releasing ids drops the temp tables (checked via `duckdb_tables()`).
    - _Requirements: 6.4–6.10_
  - [ ] 4.5 Implement dataset registration (CSV, Parquet, Arrow-from-XLSX), name sanitization, and `DatasetMeta`.
    - Verify: tests cover names `Q3 Sales.csv`→`q3_sales`, `2024.csv`→`_2024`, a collision→`_2`; a malformed CSV gives `failed` with DuckDB's message and no dataset.
    - _Requirements: 5.1–5.6_

- [ ] 5. Arrow column specs
  - [ ] 5.1 Implement `columnSpecs` for every supported Arrow type, including sliced chunks, multi-chunk columns, validity bitmaps, and utf8 offsets.
    - Verify: for each dtype, `data.buffer === ipc.buffer` (no copy); a sliced column's offsets are correct; `Decimal`/`List`/`Struct` give `ok:false` with the column name.
    - _Requirements: 8.2, 8.5, 8.6_

- [ ] 6. Pyodide worker
  - [ ] 6.1 Implement init: `loadPyodide({indexURL})` pinned to the installed version, `loadPackage(['numpy'])`, and an interrupt buffer when isolated.
    - Verify: Playwright checks that the network log contains no wheel other than numpy, and that the state is `degraded` with the exact reason string when not isolated.
    - _Requirements: 7.1–7.4, 8.7_
  - [ ] 6.2 Implement `suture_bridge.py` (§4.5) and the JS↔Python call path with `finally`-based proxy destruction.
    - Verify: tests cover each `_to_result` branch, `1/0`→`#DIV/0!`, `np.array([1.0])/0`→`#DIV/0!`, `np.log(-1)`→`#NUM!`, `2**60`→`#NUM!`, `inputs['Z9']` undeclared→`#PY!`, a fresh namespace per scenario (a global set in run 1 is absent in run 2), and a live `PyProxy` count of 0 after 1,000 runs.
    - _Requirements: 7.5, 7.6, 7.7_
  - [ ] 6.3 Implement table binding over the peer port with slice-wise `assign_to`.
    - Verify: a 1,000,000-row Float64 column binds with exactly one `assign_to` per chunk (instrumented counter), values equal the DuckDB source, and nulls appear as masked entries.
    - _Requirements: 8.1, 8.3, 8.4_
  - [ ] 6.4 Implement scalar-loop and vectorized batch modes.
    - Verify: a 200-scenario batch makes one request; vectorized `inputs['A1'].shape == (200,)`; a vectorized result of the wrong length gives `#PY!` for all scenarios; scalar-mode results equal 200 single runs bit for bit.
    - _Requirements: 7.5; Spec 01 Req 12.2, 12.3_

- [ ] 7. Deadlines and escalation
  - [ ] 7.1 Implement cooperative cancel for DuckDB (`cancelSent`) and Pyodide (interrupt ticket), with the 1,000 ms escalation.
    - Verify (isolated, Chromium): `while True: pass` times out to `#TIMEOUT!` and the worker survives (the next run succeeds without re-init); a ticket mismatch re-runs the job.
    - _Requirements: 3.4, 3.5, 3.6_
  - [ ] 7.2 Implement terminate-and-respawn on timeout when not isolated.
    - Verify (WebKit or an unisolated page): an infinite loop gives `#TIMEOUT!` on that cell only; a queued request behind it completes after respawn; datasets are queryable again.
    - _Requirements: 3.7_

- [ ] 8. Crash recovery
  - [ ] 8.1 Implement `EngineHost`: spawning, status, `jobStarted`/`jobFinished` tracking, crash classification, respawn with state restore, port replacement for all clients, the crash-loop limit, and `retry`.
    - Verify: a test-only worker entry point (never shipped) accepts a crash command that, while a job is running or when a batch reaches a given scenario index, either throws an uncaught error from the worker's global scope or posts `fatal`. Only the running cell becomes `#SQL!`/`#PY!` with `engine crashed:`; queued requests complete after respawn; a third crash within 60 s gives `failed`; `retry()` recovers. A main-thread long-task observer records no task over 50 ms during recovery.
    - Verify (classification): unit tests feed `WebAssembly.RuntimeError`, `RangeError`, and a non-`PythonError` exception to the classifier and expect `fatal`; a Python `MemoryError` expects `#PY!`; a `messageerror` yields `protocolError` and the worker survives.
    - _Requirements: 9.1–9.7_

- [ ] 9. Integration and budgets
  - [ ] 9.1 Run the Spec 01 workbook fixtures end to end against the real DuckDB and Pyodide workers.
    - Verify: values equal the expected snapshots; the same fixtures run in `packages/cli` with Node adapters give bit-identical values.
    - _Requirements: Spec 01 Req 11_
  - [ ] 9.2 Add the Playwright cold-load test (design §9).
    - Verify: it writes `cold-load.json` and fails when any Req 10.2 budget is exceeded.
    - _Requirements: 1.4, 10.1–10.3_
  - [ ] 9.3 Add the bundle-boundary check.
    - Verify: a build test asserts that the main-thread chunk graph contains no module from `@duckdb/duckdb-wasm`, `pyodide`, or `exceljs`.
    - _Requirements: 1.1–1.3_

- [ ] 10. Ingest worker
  - [ ] 10.1 Implement `ingest.worker.ts` per design §8.
    - Verify: a fixture `.xlsx` with formulas, shared formulas, dates, rich text, a cached `#N/A`, and a merged range gives the expected `raw` strings, header detection, and one warning per skipped feature.
    - _Requirements: 1.2, 5.3_
