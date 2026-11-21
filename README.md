# Suture

Suture is a zero-backend spreadsheet engine that runs entirely in your browser. One dependency graph connects three engines:

- `=SQL("…")` cells run in **DuckDB-WASM**;
- `=PY("…")` cells run in **Pyodide with NumPy**;
- ordinary formulas (`SUMIFS`, `VLOOKUP`, `IRR`, and 27 more) run in Suture's own evaluator.

The **Exorcist** is a property-based fuzzer built on [fast-check](https://fast-check.dev). It perturbs a workbook's declared inputs across all three engines, shrinks any failure to a minimal counterexample, and produces a replay link that reproduces it exactly.

**Live demo:** https://suture-nu.vercel.app

No data leaves your machine. There is no application server, no remote execution, and no telemetry endpoint.

> **Status:** Phase 3 has landed: the engine, workers, ingest, both flagship workbooks, and the test gate. The current UI is a temporary verification view (workbook picker, cell list, file import, Exorcist panel, telemetry). The virtualized grid, inspector, and X-Ray lineage overlay are Phase 4 (`.kiro/specs/04-xray-ui-and-workbooks/tasks.md`).

## Flagship workbooks

Each flagship ships with a realistic modeling flaw that its base case hides. The Exorcist finds the flaw from a fresh random seed. Nothing is scripted.

| Workbook | Pipeline | Flaw the Exorcist finds |
|---|---|---|
| **SaaS Cash Runway & Unit Economics** | DuckDB cohort SQL → NumPy least-squares burn projection (`Model!B4`) → `Model!B5 = cash / B4` | Runway divides by projected net burn with no guard. A company that turns profitable gets a negative runway and is told to "RAISE NOW". |
| **100,000-Row E-Commerce Margin Audit** | DuckDB synthesizes 100,000 orders and aggregates them once into 96 tiers. Per scenario, it runs stress SQL over the tiers, then a NumPy pivot and weighted OLS, then `SUMIFS` / `AVERAGEIF` / `VLOOKUP` KPIs. | The discount cap is applied to each discount separately instead of to the stacked total, so the Hardlines stacked cohort goes below zero net margin. |

Fresh-seed discovery times in Chromium on the Phase 3 build were 2.5–3.6 s for flagship 1 (8 runs, local and GitHub Actions) and 2.5–3.6 s for flagship 2 (10 runs). That time covers search, shrink, and decimal simplification.

## Architecture

```
packages/
  core/   ECMAScript only (no DOM, no Node built-ins)
          parser + printer, 30-function registry, dependency graph, time-sliced scheduler,
          CellValue contract, engine ports, Exorcist (search → shrink → simplify → confirm → lineage)
  web/    Vite + React + Tailwind
          EngineHost + PortClient (main thread)
          workers: DuckDB-WASM · Pyodide + NumPy · ingest (exceljs) · Exorcist
```

- **One DAG, three dialects.** `packages/core` parses each cell, builds one dependency graph, and schedules evaluation. SQL and Python cells go through engine ports (`SqlEngine`, `PyEngine`), and their results are normalized at the boundary into one `CellValue` contract: numbers, strings, booleans, errors, `TableRef` (Arrow IPC), and `Matrix2D`.
- **Top-level workers only.** The main thread creates every worker. DuckDB uses its synchronous bindings inside its own worker, so no worker spawns another. Table bytes for Python inputs move DuckDB → Pyodide over a peer `MessagePort` and are copied once into NumPy memory.
- **Host-agnostic engine handlers.** The same DuckDB, Pyodide, and ingest handler code runs in the browser workers and in the Node test host. Tests therefore exercise real engines, never mocks.
- **Hardened workers.** Deadlines escalate from cooperative cancellation (a `SharedArrayBuffer` signal when the page is cross-origin isolated) to a worker respawn. A crash respawns the worker, restores registered datasets, and then re-sends held requests in their original order. Three crashes within 60 s mark the engine `failed`, with a manual retry.
- **Safe SQL.** User SQL is one `SELECT` over registered tables, checked by DuckDB's own AST serializer, with a stricter lexical guard as fallback. File and URL reads, DDL, and external readers are rejected.
- **Bring your own data.** `.csv`, `.parquet`, and `.xlsx` files are parsed locally. The XLSX reader (exceljs) lives only in the lazily loaded ingest worker chunk.
- **Honest telemetry.** Cold boot per engine, first evaluation (which may include boot), and warm DAG evaluation are reported separately.

The design is specified in `.kiro/specs/` (requirements, design, and tasks for each of the four specs), and the binding rules are in `.kiro/steering/`.

## Local setup

Requirements: Node.js 22 or later, and pnpm (`corepack enable` picks up the pinned version from `package.json`).

```bash
pnpm install          # install the workspace
pnpm dev              # start the Vite dev server for packages/web
pnpm test             # unit, integration, and property tests (core + web, real engines in Node)
pnpm build            # production build of packages/web into packages/web/dist
pnpm typecheck        # strict TypeScript across the workspace
pnpm run licenses     # dependency license audit
```

Playwright end-to-end tests (flagships, ingest, slice, worker hardening):

```bash
pnpm --filter @suture/web exec playwright install --with-deps chromium
pnpm test:e2e         # builds the app and the fault-injection harness, then runs Playwright
```

The fault-injection harness is built by `packages/web/vite.e2e.config.ts` into `dist-e2e/`. It is never part of the production `dist`.

Deployment (`vercel.json`) serves the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. Those headers enable `SharedArrayBuffer`, which cooperative cancellation needs. Without isolation, the engines run in a degraded mode in which a timeout restarts the worker.

## License policy

Suture is released under the [MIT License](LICENSE). Dependencies must be permissively licensed:

- GPL, LGPL, and AGPL are not allowed. A dual license such as `MIT OR GPL-3.0` is accepted through its permissive alternative.
- MPL-2.0 is allowed only for the unmodified Pyodide runtime.
- A package that declares no license fails the audit.

`pnpm run licenses` (`scripts/license-check.mjs`) parses every package in `pnpm-lock.yaml` as an SPDX expression and enforces these rules. Two workspace pins in `pnpm-workspace.yaml` exist only to satisfy the policy:
- Vite is pinned to 7.x, because Vite 8 depends on `lightningcss` (MPL-2.0).
- `unzipper` is removed, because its `buffers` dependency declares no license. Suture uses exceljs's browser build, which does not need it.

## How it was built: Kiro specs and property-based testing

Suture was built with [Kiro](https://kiro.dev) in a spec-driven workflow:

1. **Steering** (`.kiro/steering/`) fixes the non-negotiables: the `CellValue` contract, error propagation, worker isolation, the license policy, and design tokens.
2. **Specs** (`.kiro/specs/01…04`) turn each subsystem into numbered requirements, a design, and a task list. Each finished task is checked off with the commit and test file that prove it.
3. **Hooks** (`.kiro/hooks/`) run after the agent writes a source file. `pbt-on-core-save` re-runs the core test and property suites and logs new counterexamples. `spec-drift-guard` compares the file against its governing design spec and reports any drift.
4. **Agents** (`.kiro/agents/`) take adversarial roles: the `pbt-adversary` writes properties meant to break the engine.

Every real bug caught by a property is logged with its seed and shrink path in [`.kiro/audit/pbt-discoveries.md`](.kiro/audit/pbt-discoveries.md). The first one is a good example. The round-trip property `parse(print(ast)) ≡ ast` generated a call whose argument divides the error literal `#N/A` by `FALSE`, and fast-check shrank it to:

```
AA(#N/A/FALSE)        seed 20261120, path "50:1:0:4:3:3"
```

The lexer matched error literals with a greedy pattern, so `#N/A/FALSE` became one unknown token and the printed formula no longer parsed. The fix matches only the 12 known error literals, longest first. Later entries in the log:
- A conformance table, then a differential property against an independent formula engine, caught `MOD` taking the wrong sign: `MOD(1, -3)` must be `-2`. Suture's `MOD` is now a native kernel.
- A real-engine ingest test caught exceljs rewriting quoted sheet names in shared formulas (`'Q3 Plan'!B2` became `'Q4 Plan'!B3`).
- Measuring the Exorcist itself showed that `fc.double` starved the upper part of float domains, hitting Flagship 2's flaw about 20× less often than its share of the domain. Float domains now sample uniformly over values.

The flagship tests follow the same rule. They contain no input values, counterexamples, or discovery seeds. Each test starts the Exorcist from `crypto.getRandomValues`, and passes only when it finds the expected assertion violation and the replay reproduces it exactly.
