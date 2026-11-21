# Tasks: Headless CLI, Suture MCP Server, Shared Node Runtime

Unit and integration tests run with `pnpm test` (each of `packages/cli` and `packages/mcp` builds its bundle first, then runs `vitest --run`). Do not use watch mode.

Phase 5 commits on `feat/cli-and-mcp`:
- 3aaebfe extracts the runtime;
- 354e0c1 is the core scheduler change;
- aa49a8f is the web incremental index and the E2E changes;
- bce9d9a adds the headless layer and the CLI;
- f7cf9c8 adds the MCP server and `.kiro/settings/mcp.json`;
- the docs commit adds this spec.

- [x] 1. Shared runtime
  - [x] 1.1 Create `packages/runtime` with the `engines`, `bridge`, `workbooks`, `headless`, and `node` entries and no root entry. Move the handlers, protocol, bridges, trust gate, and workbooks out of `packages/web` with `git mv`, split `workerRuntime.ts` (`bridge/job.ts`) and `portClient.ts` (`bridge/client.ts`), and move the real-engine tests with their code.
    - Verify: web, runtime, and core typecheck. The same 68 web unit tests pass (46 in web, 22 in runtime). Web chunk sizes are unchanged and the main chunk has no engine markers. All E2E specs pass.
    - _Requirements: 1.1–1.4_
    - Evidence: 3aaebfe. Main chunk 663.25 kB / 192.92 kB gzip after the move, against 663.25 / 193.00 before; worker chunks within 0.02 kB.
  - [x] 1.2 Implement `@suture/runtime/node`: `DirectClient`, lazy `createNodeEngineHost`, `openNodeDuckDB`, and the Node hasher, compressor, and clock. Delete `test/nodeDuckdb.ts` and its duplicate macro list.
    - Verify: the runtime real-engine tests run through it; SQL validator `ast` when online.
    - _Requirements: 1.1, 1.5, 2.6_
    - Evidence: 3aaebfe — `runtime/test/flagships.test.ts`, `ingest.test.ts`, `slice.duckdb.test.ts`, `sqlValidate.test.ts`.
  - [x] 1.3 Implement `@suture/runtime/headless` (§3) and share the value formatting, assertion labels, and Tier 1 list with the web app.
    - Verify: the CLI and MCP tests below.
    - _Requirements: 1.5, 2.1–2.5, 3.2–3.5_
    - Evidence: bce9d9a.

- [x] 2. CLI
  - [x] 2.1 Implement `suture eval | audit | replay | inspect` with the exit codes in design §4, `--json`, `--seed`, `--out-replay`, `--workbook`, `--cell`, and `--trust-python`, bundled to `packages/cli/dist/suture.mjs`.
    - _Requirements: 2.1–2.7_
    - Evidence: bce9d9a.
  - [x] 2.2 Add integration tests spawning the compiled CLI on Flagship 1, Flagship 2, and a clean workbook.
    - Verify:
      - exit 1 with the expected assertion on both flagships;
      - exit 0 with every check held on the patched Flagship 1 file;
      - identical JSON for the same fresh seed;
      - an exact replay from `--out-replay`, and exit 2 against the wrong workbook;
      - `eval` values bit-identical to in-process engines (Spec 02 task 9.1);
      - `inspect`;
      - seven exit-2 cases.
    - _Requirements: 2.1–2.5, 2.7_
    - Evidence: bce9d9a — `packages/cli/test/cli.test.ts`, 14 tests, 65 s locally.

- [x] 3. MCP server
  - [x] 3.1 Check `@modelcontextprotocol/server` and its whole dependency tree against the license policy before adding it.
    - Verify: `pnpm run licenses` passes; pnpm adds exactly 3 packages (`server` and `core` Apache-2.0, `zod` MIT); Pyodide is still the only MPL-2.0 package.
    - _Requirements: 3.9_
    - Evidence: f7cf9c8; design §5.1.
  - [x] 3.2 Implement `suture-mcp` with `suture_list_workbooks`, `suture_inspect_lineage`, `suture_run_audit`, and `suture_verify_patch`: zod schemas, the workspace path guard, serialized evaluation, and stdout reserved for JSON-RPC.
    - _Requirements: 3.1–3.7_
    - Evidence: f7cf9c8 — `packages/mcp/src/tools.ts`, `src/main.ts`.
  - [x] 3.3 Add stdio integration tests against the compiled server.
    - Verify:
      - `initialize` and `tools/list`;
      - `suture_run_audit` fails Flagship 1;
      - `suture_verify_patch` returns `ok: true` with zero regressions for `=IF(B4<=0,120,Inputs!B2/B4)`, and `ok: false` for a no-op patch;
      - the path guard;
      - a second process completes `server/discover` and `tools/call` with `_meta` only;
      - stdout carries nothing but JSON-RPC.
    - _Requirements: 3.1–3.7_
    - Evidence: f7cf9c8 — `packages/mcp/test/stdio.test.ts`, 6 tests, 18 s locally.
  - [x] 3.4 Write `.kiro/settings/mcp.json` in the current Kiro format (`mcpServers` → `command`, `args`, `disabled`, `autoApprove`, `disabledTools`).
    - Verify: launching the configured command from the repository root completes `initialize` and lists the four tools.
    - _Requirements: 3.8_
    - Evidence: f7cf9c8.

- [x] 4. Python trust in Node hosts
  - [x] 4.1 Gate `=PY()` for non-flagship workbooks behind `--trust-python` / `trustPython: true`, and document the verified `js.process.getBuiltinModule("fs")` boundary here and in steering §7.
    - Verify: `eval` of a `.suture.json` copy of Flagship 1 reports Python `blocked` and `#PY!` with the exact message until `--trust-python`; MCP `suture_list_workbooks` and `suture_inspect_lineage` report a workspace file's Python as `blocked`.
    - _Requirements: 4.1–4.3_
    - Evidence: bce9d9a, f7cf9c8; design §6.

- [ ] 5. Follow-ups (not in Phase 5)
  - [ ] 5.1 A `worker_threads` Node engine host with SharedArrayBuffer interrupts and terminate-and-respawn, so a non-terminating kernel becomes `#TIMEOUT!` in the CLI and MCP server (design §8).
  - [ ] 5.2 An offline engine cache (NumPy wheel and DuckDB extensions) for air-gapped CI.
