# Design: Headless CLI, Suture MCP Server, Shared Node Runtime

Implements `requirements.md` in this folder.

## 1. Package layout

```
packages/
  core/      unchanged: DAG, scheduler, Exorcist (ES2022 only)
  runtime/   @suture/runtime — TypeScript source like core, "sideEffects": false, no root entry
    src/engines/    DuckDB / Pyodide / ingest handlers, SQL validator, python/suture_bridge.py
    src/bridge/     wire protocol, Job + EngineClient contracts, SqlBridge / PyBridge, isolation, trust gate, versions
    src/workbooks/  flagships, Blank Workbook, validateDocument, the flagship:1 / flagship:2 registry
    src/headless/   evaluate · audit · replay · inspect · verifyPatch, JSON value encoding, display formatting
    src/node/       in-process engine host, node:crypto / node:zlib adapters, file loading, workspace scan
    test/           real-engine tests (moved from packages/web in Phase 5)
  web/       browser host: React UI, worker entries, EngineHost, PortClient transport, browser engine loaders
  cli/       suture: argument parsing, plain-text printers, exit codes
  mcp/       suture-mcp: MCP server, four tools, argument schemas
```

| Entry | Contents | Imported by | Allowed APIs |
|---|---|---|---|
| `@suture/runtime/engines` | request handlers | web workers, `node` | ES2022 + web-platform globals present in browsers and Node 22 (`fetch`, `AbortController`, `Atomics`, `WebAssembly`) |
| `@suture/runtime/bridge` | protocol, clients, bridges, trust gate | web main thread and workers, `node`, `headless` | same |
| `@suture/runtime/workbooks` | documents, validation, registry | web, `headless`, `node`, cli, mcp | ES2022 |
| `@suture/runtime/headless` | the CLI and MCP operations, report types | cli, mcp, web (formatting and labels only) | ES2022 |
| `@suture/runtime/node` | engine host, adapters, files | cli, mcp, runtime tests | Node APIs |

The barrels never import across that boundary. The web main chunk keeps its markers at zero: no DuckDB, Pyodide, exceljs, or headless report code (checked on every build in the PR gate).

The CLI and MCP bundles are built with `vite build --ssr`. Vite compiles the TypeScript sources of core and runtime (parameter properties, `.ts` imports, the `?raw` Python bridge) into one Node ESM file per tool. Every pure-JavaScript dependency is bundled. DuckDB-WASM and Pyodide stay external dependencies, because they load `.wasm` and stdlib files from their own package directories. The MCP SDK and zod stay external too. Sizes: `cli/dist/suture.mjs` 860.8 kB, `mcp/dist/suture-mcp.mjs` 860.7 kB.

## 2. Node engine host (`@suture/runtime/node`)

- `createNodeEngineHost()` wraps the same DuckDB and Pyodide handlers the browser workers run in a `DirectClient`, an in-process `EngineClient` that serializes requests like a worker queue.
- **Lazy boot.** Each engine boots on the first request that needs it, so a formula-only workbook never starts Pyodide and a static `inspect` starts nothing.
- **DuckDB.** It loads `duckdb-eh.wasm` through duckdb-wasm's synchronous Node bindings (`createRequire`, because the package's `exports` omit them). `HOME` points at one private temporary directory per process, where DuckDB installs the JSON (and, on first use, Parquet) extension. Without network access, the SQL validator falls back to the stricter lexical guard and reports `validator: lexical`.
- **Pyodide.** It loads from the `pyodide` package directory. NumPy downloads from the Pyodide CDN on the first boot and is cached next to the package. Both the loader and `loadPackage` are silenced, because stdout belongs to the CLI output and the MCP stream.
- **No interrupts.** In-process there is no SharedArrayBuffer interrupt and no terminate-and-respawn, so a kernel that never returns blocks the host (Req 2.6). A `worker_threads` host with interrupt buffers is the documented follow-up (§8). The trust gate (§6) means untrusted Python never runs at all.
- **Adapters.** `nodeHasher` (`node:crypto`), `nodeCompressor` (`node:zlib` deflate-raw), and `nodeClock` (`performance`), plus `NODE_VERSIONS` from the shared `SUTURE_VERSION` / `FAST_CHECK_VERSION`.
- **Recalculation.** Node hosts recalculate with `sliceMs: 0` (there is no frame to protect), so they never yield and never read the clock during evaluation.

## 3. The headless layer (`@suture/runtime/headless`)

### 3.1 Workbooks

```ts
interface HeadlessHost { engine: EngineDeps; hasher: Hasher; compressor: Compressor; versions: { suture; fastCheck }; randomSeed(): number }
interface Workbook { ref; source: 'flagship' | 'file'; document /* canonical */; hash; python: 'none' | 'trusted' | 'blocked'; pyCells }
```

- `openWorkbook` replaces the document's workbook with the engine's `definition()`, the same canonical form the web app hashes. That is what makes CLI, MCP, and web artifacts interchangeable (Req 1.5).
- `engineDepsFor(wb)` wraps the Python port with `gatedPyEngine` when Python is blocked.

### 3.2 JSON values

- Numbers, strings, booleans, and `null` stay JSON scalars. Numbers use JavaScript's shortest round-trip form; non-finite numbers never reach a cell.
- Errors become `{ error, message, origin, engine }`.
- Tables become `{ table: { rows, columns } }`; table bytes are never serialized.
- Matrices become `{ matrix: { rows, cols, data } }`, with `data` included up to 256 values.

### 3.3 Reports

Every report carries `format` and `version`. Wall-clock values (`durationMs`) live only in `meta`. The replay artifact keeps its own `createdAt`, so the CLI's determinism check strips exactly `meta`, `replay.artifact.createdAt`, and `replay.fragment`.

| Function | Report | Notes |
|---|---|---|
| `evaluateWorkbook` | `suture.eval` | cells sheet by sheet in row-major order, errors, cycles |
| `auditWorkbook` | `suture.audit` | see below |
| `replayWorkbook` | `suture.replay-check` | `exact` / `direct` / `notReproduced` / `hashMismatch` from `ExorcistSession.replay` |
| `inspectLineage` | `suture.lineage` | static: dialect, raw source, parsed form, precedents, dependents, upstream, downstream, chain, cyclic |
| `verifyPatch` | `suture.verify-patch` | §3.5 |

`auditWorkbook` derives everything deterministically:
- `search.runs` is the failing run's index plus one, and `search.shrinkSteps` is the number of accepted shrink steps. Both are read from the replay path (`start:shrink:…|digits`), which has the same shape in both execution modes. Progress events are throttled by time and are not used.
- Tier statuses: a Tier 2 violation means every Tier 1 invariant held, because they are checked first. The violated assertion is `violated`, later ones are `not reached`, and a passed run marks everything `held`.
- The lineage is the artifact's `lineagePath.cells`. Each cell is evaluated under the counterexample (`evaluateScenarioBatch`, no state change) and at the base case.

### 3.4 Inspect and lineage

- `upstream` and `downstream` are the transitive closures through `precedents` and `dependents`.
- `chain` is one Kahn order over their union with the cell, ties broken row-major. Cells that cannot be ordered sit on a cycle and are appended row-major as `cyclic`.

### 3.5 Verify a patch

1. Normalize the patches (an array or a map, one or more cells, no duplicates) and apply them as `setCell` / `clearCell` edits to an engine built from the canonical document. The patched document is that engine's `definition()`, with its own hash. Parse errors and SQL template errors become `patchErrors`, and so does a patch that breaks the Exorcist configuration (for example a fuzz input turned into a formula); in that case nothing else runs.
2. Find the original counterexample: the given replay artifact (which must match the original workbook's hash; its seed is reused), or an audit of the original with `seed`.
3. Replay that artifact against the patched model. The artifact is re-tagged with the patched hash, so the seed and path regenerate the same failing inputs, and every Tier 1 invariant and Tier 2 assertion is checked. `notReproduced` means `counterexampleFixed: true`.
4. Run a fresh audit of the patched model with the same seed: `freshAuditPassed`.
5. Evaluate both base cases. A **regression** is either a Tier 2 assertion that holds at the original base case and fails at the patched one (`monotonicWith` is paired, so the audit covers it), or a cell that newly evaluates to an error. `baseValueDiffs` lists every changed base-case value, for information only.
6. `ok = counterexampleFixed !== false && freshAuditPassed && regressions.length === 0`.

For Flagship 1, `Model!B5 = =IF(B4<=0,120,Inputs!B2/B4)` (the repository's control) gives `ok: true` with no base-case diffs, because the base case burns cash. For Flagship 2 the flaw sits in `Segments!A3`'s SQL; guarding `Margins!B5` would hide it, and the fix is `STRESS_SQL_FIXED`.

## 4. CLI (`packages/cli`)

- Arguments are parsed with `node:util` `parseArgs` in strict mode. `--seed -42` is accepted by rewriting it to `--seed=-42`, because `parseArgs` reads a leading dash as a flag.
- Output is plain text with no colors, or the report as indented JSON with `--json`.
- Exit codes:

| Command | 0 | 1 | 2 | 130 |
|---|---|---|---|---|
| `eval` | evaluated | — | error | — |
| `audit` | every check held | violation | configuration, input, or runtime error | interrupted |
| `replay` | reproduced exactly | reproduced only directly, or not reproduced | artifact from another workbook, or error | — |
| `inspect` | inspected | — | error | — |

- The first Ctrl+C cancels the Exorcist session (verdict `stopped`, exit 130); a second one exits at once. The process exits explicitly after printing, because the engines hold open handles.

Measured locally, each run boots its own engines: `eval flagship:1` 3.9 s, `audit flagship:1` 6.1 s, `replay` 4.0 s, `audit flagship:2` about 11 s.

## 5. MCP server (`packages/mcp`)

### 5.1 SDK and licenses

`@modelcontextprotocol/server` 2.4.0 (Apache-2.0) depends only on `@modelcontextprotocol/core` 2.4.0 (Apache-2.0) and `zod` 4.6.7 (MIT). `pnpm install` added exactly these 3 packages, and `pnpm run licenses` passes. The v1 `@modelcontextprotocol/sdk` 1.32.2 was checked too: 95 packages including express, hono, and jose, all permissive, but far larger. The SDK's `serveStdio` answers both protocol eras on one stdio stream: `initialize` (2025-11-25) and `server/discover` with per-request `_meta` (2026-07-28). A hand-written JSON-RPC server was not needed.

### 5.2 Tools

| Tool | Arguments | Annotations | Boots engines |
|---|---|---|---|
| `suture_list_workbooks` | none | read-only, idempotent, closed world | no |
| `suture_inspect_lineage` | `workbook`, `cell` | read-only, idempotent, closed world | no |
| `suture_run_audit` | `workbook`, `seed?`, `trustPython?` | read-only, closed world | yes |
| `suture_verify_patch` | `workbook`, `patches`, `replayArtifact?`, `seed?`, `trustPython?` | read-only, closed world | yes |

- Each result carries the report as `structuredContent` and as indented JSON text.
- Input errors return `isError: true` with the reason.
- Calls that evaluate run one at a time over the shared, warm engines.
- `--root <dir>` (else `SUTURE_WORKSPACE`, else the working directory) is the workspace root. Workbook paths resolve against it and, after following symlinks, must stay inside it. `findWorkbookFiles` skips hidden, `node_modules`, and build directories (depth 8, at most 500 files).
- `console.log` and `console.info` are redirected to stderr, so no library can write into the JSON-RPC stream.

### 5.3 Kiro configuration

`.kiro/settings/mcp.json` runs `node packages/mcp/dist/suture-mcp.mjs`. Kiro IDE starts stdio servers in the first workspace folder (kiro.dev, multi-root workspaces). For Kiro CLI the working directory is not documented, so launch it from the repository root. Run `pnpm install && pnpm build` first. Only the two static tools are auto-approved: `suture_run_audit` and `suture_verify_patch` evaluate the workbook (and its Python, with `trustPython`), so Kiro asks before each call.

## 6. Python trust boundary in Node

Verified in Phase 5: with Pyodide 314.0.8 on Node 22, `import js; js.process.getBuiltinModule("fs").existsSync("/etc/hostname")` returns `True` from inside a `=PY()` cell. In the browser, Pyodide runs inside a worker sandbox. Under Node, the JavaScript bridge exposes the host process, its file system, and its network. Narrowing Pyodide's `jsglobals` was not evaluated as a sandbox and is not relied on.

The rule is therefore: built-in flagships run their Python, and every other workbook's `=PY()` cells evaluate to `#PY!` ("Python is blocked until you trust this workbook") without booting Pyodide, unless the caller passes `--trust-python` or `trustPython: true`.

## 7. Testing

The repository's flagship rule holds: tests pick seeds from `crypto.getRandomValues` and assert only verdicts, assertion ids, outcomes, and exit codes, never counterexample values.
- **`packages/cli/test/cli.test.ts`** (14 tests) spawns the compiled binary:
  - `eval` on both flagships, values bit-identical to the in-process engines;
  - the trust gate on a `.suture.json` copy of Flagship 1;
  - `audit` exiting 1 on both flagships with their expected assertions and lineage through SQL and Python, and identical JSON for the same seed;
  - `--out-replay`, then `replay` exiting 0 with an exact reproduction, and 2 against the wrong workbook;
  - a patched Flagship 1 file exiting 0 with every check held;
  - `inspect`, and seven exit-2 cases.
- **`packages/mcp/test/stdio.test.ts`** (6 tests) spawns the compiled server with a JSON-RPC 2.0 client written in the test, so the wire format is under test:
  - `initialize`, `notifications/initialized`, and `tools/list` (four tools, annotated);
  - `suture_list_workbooks` and `suture_inspect_lineage`, and the path guard;
  - `suture_run_audit` failing Flagship 1, then `suture_verify_patch` returning `ok: true` for the guarded patch and `ok: false` for a no-op patch;
  - a second process using `server/discover` and `_meta` only, with no handshake;
  - both processes keep stdout free of anything but JSON-RPC.

## 8. Known limits and follow-ups

- **No interrupts in Node.** In-process engines cannot interrupt a non-terminating kernel. Follow-up: a `worker_threads` host with SharedArrayBuffer interrupts and terminate-and-respawn, mirroring the browser `EngineHost`; Node's permission model could then confine trusted Python.
- **Network on first boot.** The first boot needs the network for NumPy (Pyodide CDN) and DuckDB's JSON extension; no user data is sent.
- **No `RangeIndex` yet.** Range lookups are a linear scan (Spec 01 task 6.1).
