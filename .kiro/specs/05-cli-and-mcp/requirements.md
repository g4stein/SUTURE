# Requirements: Headless CLI, Suture MCP Server, Shared Node Runtime

## Introduction

This spec turns Suture's engine into a developer toolchain that runs outside the browser:
- a shared runtime package, `packages/runtime`, so the web app, the CLI, and the MCP server run one copy of the engine handlers;
- the `suture` command-line tool, `packages/cli`;
- the `suture-mcp` Model Context Protocol server, `packages/mcp`, with a workspace `.kiro/settings/mcp.json` so Kiro loads it.

It obeys `.kiro/steering/architecture-and-isolation.md` (the §1 package table, the §5 license policy, and the §7 Python-in-Node rule) and leaves `packages/core` unchanged in its boundaries.

It uses these types unchanged:
- **Spec 01:** `WorkbookEngine`, `EngineDeps`, `CellKey`, `CellValue`, `ParsedCell`, `FormulaAst`, `Edit`.
- **Spec 02:** the wire protocol, `JobHandler`, `EngineClient`, `SqlBridge`, `PyBridge`, the DuckDB and Pyodide handlers.
- **Spec 03:** `SutureDocument`, `ExorcistSession`, `ExorcistVerdict`, `ReplayArtifact`, `ReplayOutcome`, `ViolatedAssertion`, `Hasher`, `Compressor`.

## Requirements

### Requirement 1: One shared runtime

**User Story:** As a maintainer, I want the browser, the CLI, and the MCP server to run the same engine code, so that a result in one host is a result in all of them.

#### Acceptance Criteria
1. THE SYSTEM SHALL keep the host-agnostic DuckDB-WASM, Pyodide, and XLSX ingest handlers, the wire protocol, the core-port bridges, the Python trust gate, and the flagship workbooks in `packages/runtime`, and SHALL NOT duplicate them in `packages/web`, `packages/cli`, or `packages/mcp`.
2. THE SYSTEM SHALL expose `packages/runtime` only through the subpath entries `engines`, `bridge`, `workbooks`, `headless`, and `node`, with no root entry, and the web main thread SHALL NOT import `engines` or `node`.
3. THE SYSTEM SHALL allow Node APIs only in the `node` entry; the other entries SHALL compile against the ES2022 and DOM libraries with no Node types.
4. THE SYSTEM SHALL leave `packages/core` free of DOM and Node globals (ES2022 lib, `types: []`).
5. THE SYSTEM SHALL hash documents in their canonical form (the engine's `definition()`) and record one `SUTURE_VERSION` in every host, so replay artifacts move between the web app, the CLI, and the MCP server.

### Requirement 2: The `suture` CLI

**User Story:** As an engineer, I want to evaluate and audit a model from a terminal or a CI job, with exit codes I can gate on.

#### Acceptance Criteria
1. WHEN the user runs `suture eval <workbook> [--json]`, THE SYSTEM SHALL evaluate the full cross-engine DAG against the real DuckDB-WASM and Pyodide engines and print every non-empty cell's dialect and value, every error, and every cycle, exiting `0`.
2. WHEN the user runs `suture audit <workbook> [--seed <n>] [--json] [--out-replay <file>]`, THE SYSTEM SHALL run the Exorcist and print the verdict, the Tier 1 and Tier 2 statuses, the shrunk counterexample, and the failing lineage evaluated under the counterexample and at the base case; it SHALL write the replay artifact to `<file>` when asked, and exit `0` when everything held, `1` when it found a violation, `2` on a configuration, input, or runtime error, and `130` when interrupted.
3. WHEN the user runs `suture replay <replay.json> [--workbook <workbook>] [--json]`, THE SYSTEM SHALL find the workbook (the given one, or the built-in flagship whose hash matches), replay the artifact, and exit `0` when it reproduces exactly, `1` when it reproduces only directly or not at all, and `2` when the artifact belongs to a different workbook or the input is invalid.
4. WHEN the user runs `suture inspect <workbook> --cell <Sheet!A1> [--json]`, THE SYSTEM SHALL print the cell's dialect, source, parsed form (formula AST, SQL slots, or Python inputs), precedents, dependents, and topological lineage, without booting an engine.
5. THE SYSTEM SHALL accept `<workbook>` as `flagship:1`, `flagship:2`, or a `.suture.json` path, and SHALL print identical `--json` output for the same inputs and seed, except the `meta` object, the replay artifact's `createdAt`, and the replay fragment that encodes it.
6. THE SYSTEM SHALL run the engines in-process and SHALL document that a kernel that never returns blocks the command, because nothing can interrupt it in-process.
7. IF the input is invalid, THEN THE SYSTEM SHALL print the reason to stderr (and a `suture.error` JSON object with `--json`) and exit `2`.

### Requirement 3: The Suture MCP server

**User Story:** As a Kiro user, I want the agent to audit and fix models inside the IDE and CLI loop, with the real engines.

#### Acceptance Criteria
1. THE SYSTEM SHALL serve MCP over stdio and SHALL answer both the 2025-11-25 `initialize` handshake and the stateless 2026-07-28 revision (`server/discover`, per-request `_meta`).
2. THE SYSTEM SHALL provide `suture_list_workbooks`, listing the built-in flagships and every `.suture.json` file under the workspace root with sheets, cell counts, fuzz inputs, assertions, and Python status.
3. THE SYSTEM SHALL provide `suture_inspect_lineage`, returning a cell's dialect, source, parsed form, precedents, dependents, upstream and downstream cells, and full topological chain.
4. THE SYSTEM SHALL provide `suture_run_audit`, returning the Exorcist verdict, Tier 1 and Tier 2 statuses, the shrunk `failingInputs`, the `lineagePath`, and the replay artifact.
5. THE SYSTEM SHALL provide `suture_verify_patch`, which applies one or more cell patches (an array of `{ cell, formula }` or a `{ cell: formula }` map) to an in-memory copy of the workbook, replays the original counterexample, runs a fresh audit with the same seed, compares both base cases, and returns `{ ok, seed, counterexampleFixed, freshAuditPassed, regressions, baseValueDiffs }`; it SHALL NOT write to disk.
6. THE SYSTEM SHALL treat every tool argument as untrusted: narrow it with a schema, validate replay artifacts with `isReplayArtifact`, and refuse workbook paths that resolve outside the workspace root.
7. THE SYSTEM SHALL write only JSON-RPC messages to stdout.
8. THE SYSTEM SHALL ship `.kiro/settings/mcp.json`, which launches the server from the workspace root and auto-approves only the two tools that run no workbook code (`suture_list_workbooks`, `suture_inspect_lineage`).
9. THE SYSTEM SHALL add no dependency that fails `pnpm run licenses`.

### Requirement 4: Python trust in Node hosts

**User Story:** As a user, I want a downloaded workbook to be unable to run code on my machine unless I say so.

#### Acceptance Criteria
1. THE SYSTEM SHALL run `=PY()` cells of the built-in flagships, and SHALL run the `=PY()` cells of any other workbook only when the caller passes `--trust-python` (CLI) or `trustPython: true` (MCP).
2. WHILE a workbook's Python is not trusted, THE SYSTEM SHALL evaluate its `=PY()` cells to `#PY!` with the message "Python is blocked until you trust this workbook" without starting Pyodide, and SHALL report the workbook's Python status as `blocked`.
3. THE SYSTEM SHALL document in Spec 05 and in the steering rules that Python under Pyodide in Node can reach Node built-in modules (for example `js.process.getBuiltinModule("fs")`), so trusting a workbook means trusting it like a script.
