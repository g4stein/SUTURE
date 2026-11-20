---
inclusion: always
---

# Architecture & Isolation

Suture is a zero-backend, local-first spreadsheet engine. Every computation runs on the user's machine. There is no application server, no remote execution, and no telemetry endpoint. These rules are binding for all code in this repository.

## 1. Monorepo boundaries

| Package | Purpose | Allowed runtime APIs |
|---|---|---|
| `packages/core` | DAG, scheduler, formula evaluation, `CellValue` contract, coercion, error propagation, engine port interfaces | ECMAScript only (ES2022 lib). No DOM, no Node built-ins. |
| `packages/web` | Vite + React + Tailwind UI, Web Worker engine adapters (DuckDB-WASM, Pyodide) | Browser APIs |
| `packages/cli` | Command-line host for `core` | Node.js APIs |
| `packages/mcp` | Model Context Protocol server host for `core` | Node.js APIs |

### `packages/core` purity rules
- `core` must run identically in the browser, the CLI, the MCP server, and Kiro agent sessions.
- Never reference `window`, `document`, `self`, `globalThis.document`, `navigator`, `localStorage`, `Worker`, `postMessage`, `fetch`, or any Node module (`fs`, `path`, `worker_threads`, `process`).
- `core/tsconfig.json` uses `"lib": ["ES2022"]` with no `"DOM"` entry and `"types": []`, so a forbidden global is a compile error rather than a review finding.
- `core` defines engine *ports* (TypeScript interfaces such as `SqlEngine` and `PyEngine`). Hosts (`web`, `cli`, `mcp`) provide *adapters*. `core` never imports from another package; dependencies point inward only: `web | cli | mcp -> core`.
- Time and randomness are injected (clock and seed parameters), never read from globals, so evaluation is deterministic and replayable under `fast-check`.

### TypeScript rules (all packages)
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- No `any` (explicit or implicit). Values crossing a trust boundary (worker messages, file import, MCP input) are typed `unknown` and narrowed by a validator before use.
- No stubbed functions, mocked engines in production code paths, or placeholder comments. Unimplemented behavior is not merged.

## 2. Worker isolation

- DuckDB-WASM and Pyodide MUST NEVER be instantiated or executed on the main UI thread. Each runs in its own dedicated Web Worker in `packages/web`.
- The main thread owns only: React rendering, input handling, the virtualized grid, and message routing.
- `core` may evaluate literal and formula cells on the main thread for the **whole dirty set**, not only visible cells, because off-screen cells feed visible KPIs and assertions. It does so in synchronous slices of at most 8 ms, yielding to the event loop between slices (`RecalcOptions.sliceMs` + `EngineDeps.yieldControl`) to preserve 60 fps. Any evaluation that awaits an engine is asynchronous and never blocks a frame.
- **Zero nested workers.** No worker ever creates another worker. The main thread creates every worker (DuckDB, Pyodide, ingest, Exorcist) as a top-level dedicated worker, and workers reach each other only through `MessageChannel` ports handed out by the main thread. This also rules out engine builds that spawn their own sub-workers, such as DuckDB's pthread (COI) bundle.
- Every worker request carries a request id and a recalculation generation id. Responses for a superseded generation are discarded (see `dag-and-type-contract.md`, Scheduling).
- Worker messages are validated on receipt on both sides. A malformed message is a protocol error, logged and surfaced as `#SQL!` or `#PY!` on the requesting cell; it never crashes the worker or the UI.

## 3. Wire format: Arrow IPC

- All tabular data moving between DuckDB, Pyodide, and the main thread is **Arrow IPC stream format** carried as a `Uint8Array`.
- The underlying `ArrayBuffer` is passed in the `postMessage` transfer list (`Transferable`), so ownership moves instead of copying.
- Before transfer, the sender ensures the `Uint8Array` owns its entire buffer (`byteOffset === 0 && byteLength === buffer.byteLength`). If it does not, the sender slices it into a dedicated buffer first. Transferring a view onto a shared, larger buffer is forbidden: it detaches memory the sender still uses and ships unrelated bytes.
- After transfer, the sender must not touch the transferred buffer.
- Large tables are NEVER serialized to JSON or passed as arrays of row objects. Structured clone of plain objects is reserved for small control messages and scalar `CellValue`s.
- `Matrix2D` values travel as a row-major `Float64Array` plus `rows` and `cols`, with the `Float64Array`'s buffer transferred under the same ownership rules.
- DuckDB to Pyodide data flows over a `MessageChannel` port connecting the two workers directly, so table bytes do not pass through main-thread application logic.
- Inside the Pyodide worker, Arrow IPC is decoded in the worker's JavaScript layer with `apache-arrow`. Numeric columns are handed to NumPy as typed-array buffers (`numpy.frombuffer` / `numpy.asarray`). `pyarrow` and `pandas` are not used.

## 4. Cross-origin isolation & fallback

Production deployments (Vercel) send these headers on every document and worker script:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

- `credentialless` is chosen over `require-corp` so cross-origin assets such as the Pyodide and DuckDB bundles load without each origin sending `Cross-Origin-Resource-Policy`.
- At startup the app reads `globalThis.crossOriginIsolated` and checks that `SharedArrayBuffer` exists.
- DuckDB always uses its single-threaded bundle (`eh`, else `mvp`), loaded with duckdb-wasm's synchronous bindings inside the DuckDB worker. The COI bundle is not used, because it spawns pthread sub-workers (forbidden by §2). Cell evaluation is single-threaded for determinism anyway.
  - **Isolated:** each engine worker gets a `SharedArrayBuffer` control buffer. For Pyodide it is the interrupt buffer. For DuckDB it is a cancel flag that the worker checks between result chunks. Cancels and timeouts are cooperative, and the worker survives.
  - **Escalation:** if a cooperative cancel does not settle within 1,000 ms, the worker is terminated and respawned, even when isolated. This happens, for example, when a C/NumPy kernel never reaches Python's interrupt check, or when a single long DuckDB operator never yields a chunk. Only that request's cells become `#TIMEOUT!`, and queued work is re-dispatched after engine state is restored.
  - **Not isolated** (for example, browsers without COEP `credentialless` support, or a preview deployment missing headers): there is no shared buffer, so timeouts use terminate-and-respawn directly (see `dag-and-type-contract.md`, Timeouts). The app stays fully functional.
- Degraded mode is shown honestly in the engine readiness indicator. It is never hidden and never treated as an error.

## 5. Dependency & license policy

- The repository is MIT. Only MIT, Apache-2.0, BSD, or ISC dependencies are allowed. The one named exception is `pyodide` (MPL-2.0), approved because it is used as an unmodified runtime loaded in a worker and is never vendored or modified.
- **Forbidden:** any GPL, LGPL, or AGPL dependency, including HyperFormula.
- **Approved core libraries:** `fast-formula-parser` (MIT), `@formulajs/formulajs` (MIT), `@duckdb/duckdb-wasm` (MIT), `apache-arrow` (Apache-2.0), `pyodide` (MPL-2.0 runtime, loaded in a worker), `fast-check` (MIT), `exceljs` (MIT).
- **Pyodide packages:** NumPy only. `pyodide.loadPackage` is called with `numpy` and nothing else. SciPy, pandas, and pyarrow are forbidden.
- Adding a runtime dependency outside this list requires an explicit license check recorded in the PR description.

## 6. Kiro configuration is tracked

`.kiro/` (steering, agents, hooks, specs, audit) is part of the source of truth. It is never added to `.gitignore`.
