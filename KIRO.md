# How Kiro built Suture

Suture was built in **Kiro Web** across a few days of sessions. Every claim below points to a file or a commit in this repository, or in [`g4stein/suture-crew`](https://github.com/g4stein/suture-crew), so a judge can check it.

## Kiro Web: one long build, steered by a working rule

Suture went from an empty repository to six phases (0–5), three polish passes, nine pull requests, and a published npm package:

| PR | What landed |
|---|---|
| #1 | Phase 0: the Kiro constitution: steering, hooks, agents |
| #2 | Phase 1: four specs |
| #3 | Phase 2: a vertical slice |
| #4 | Phase 3: the engine and the flagships |
| #5 | Phase 4: the production UI |
| #6 | Phase 5: the CLI and MCP server |
| #7 | npm packaging and polish |
| #8 | Final judge polish: Crew links open directly, the judge path on WebKit and Firefox in CI, a one-row command bar, this write-up |
| #9 | A full pre-submission audit: every doc claim re-checked against the code, a CI bundle-budget gate, replay and phone-layout fixes, accessibility fixes |

- **Discuss-first rule.** Early on we stored it as a Kiro learning: before any edit, Kiro proposes options, trade-offs, and a recommendation, then waits for approval; read-only investigation is free. Each phase therefore started with a written proposal and a numbered list of decisions, and only then code.
- **Sub-agents** handled the investigation:
  - `context-gatherer` agents mapped the engine layout, the scheduler hot path, and the Exorcist API in parallel before the Phase 5 refactor.
  - The `introspect` agent read the Kiro docs to get `.kiro/settings/mcp.json` exactly right.
- **One verification gate**, enforced in every phase and then in CI:
  - license audit, typecheck, unit and property tests, build with a bundle budget;
  - the Playwright end-to-end suite on Chromium (since PR #8, also the judge path on WebKit and Firefox);
  - for the npm package, a packed-tarball smoke test.

## Spec-driven development: 5 specs, 291 EARS criteria

`.kiro/specs/` holds a requirements, design, and tasks file for each subsystem:

| Spec | Subsystem |
|---|---|
| `01-cross-engine-dag` | DAG, scheduler, `CellValue` contract, 30 functions |
| `02-wasm-worker-bridge` | DuckDB-WASM and Pyodide workers, Arrow IPC, deadlines, crash recovery |
| `03-exorcist-pbt-fuzzer` | property-based fuzzing, shrinking, replay artifacts |
| `04-xray-ui-and-workbooks` | the grid, X-Ray, Audit Studio, flagship workbooks |
| `05-cli-and-mcp` | the shared runtime, the `suture` CLI, the MCP server, the npm package |

- **Acceptance criteria.** Requirements are written in EARS form (`WHEN … THE SYSTEM SHALL …`), 291 criteria in total.
- **Tasks.**
  - Each task carries a *Verify* line (the test that proves it) and, once done, an *Evidence* line with the commit and the test file. 102 of 146 task items are checked off.
  - Open items stay open and marked *Partial*, with what is missing. Examples: Spec 01's range index, and Spec 04's post-crash pill sequence on the app page.
- **Why it beat vibe coding here.** Three engines must agree on one value contract. The spec pinned that contract before any code existed: error codes, `-0`, non-finite numbers, Arrow IPC ownership. Later phases then had an exact target.

  One example: the 20,000-formula recalculation stayed a `test.fixme` *with the 50 ms limit unchanged* for a whole phase. The fix landed only when Spec 01's scheduler design said how: incremental graph, sliced preamble (`354e0c1`).

## Steering: the non-negotiables, loaded automatically

`.kiro/steering/` has three files:
- **`architecture-and-isolation.md`** (`inclusion: always`): package boundaries (`core` is pure ES2022, with no DOM or Node), zero nested workers, Arrow IPC transfer rules, COOP/COEP and degraded mode, the license policy (Pyodide is the only MPL-2.0 package), and the Python-in-Node trust rule.
- **`dag-and-type-contract.md`** (`inclusion: always`): the `CellValue` union, the 10 error codes, propagation, determinism, and scheduling.
- **`ui-craft-and-branding.md`** (`inclusion: fileMatch`): design tokens, X-Ray rules, honest readiness states, and trademark hygiene.

The strategy that made the biggest difference was turning each steering rule into something a machine checks:
- the `core` tsconfig has `lib: ["ES2022"]` and `types: []`, so a DOM or Node global is a compile error;
- `scripts/license-check.mjs` parses every lockfile entry as SPDX;
- a hex-color scanner and a digest-based trademark scan run in the unit tests;
- the MCP package build fails if a bundled dependency has no license file.

## Agent hooks

`.kiro/hooks/` (both use `PostToolUse` on the agent's `write` tool, because Kiro Web does not run file-save triggers):
- **`pbt-on-core-save`** re-runs the `packages/core` Vitest and fast-check suite after the agent writes a core file. It logs any new shrunk counterexample, with its seed and path, to `.kiro/audit/pbt-discoveries.md`.
- **`spec-drift-guard`** routes each written file to its governing design spec (Exorcist → Spec 03, other core files → Spec 01, worker, bridge, DuckDB, or Pyodide files → Spec 02). It reports schema drift, or `SPEC MISSING`, instead of letting code and spec diverge silently.

The Crew repo's `.kiro/hooks/crew-app-guard.json` adds two command hooks. A `PostFileSave` hook rebuilds the dashboard bundle and re-runs the Kiro Crew manifest rules, the bundle-externals check, the trademark scan, and the license policy whenever a manifest, agent, skill, UI, or backend file changes. A `Stop` hook re-runs the license audit and the trademark scan when the agent ends its turn.

## Custom agents

`.kiro/agents/` defines three adversarial roles, each scoped to steering and to its spec:
- **`dag-architect`** (read and shell only): audits `packages/core` for topological correctness, cycle detection, error propagation, and DOM-free purity. It reports and does not edit.
- **`pbt-adversary`** (read, write, shell): writes fast-check arbitraries meant to break parser round-trips, numeric precision, and cross-engine determism. It may write only tests and the discoveries log.
- **`wasm-perf-auditor`** (read and shell only): audits the worker protocol, Arrow buffer transfer, memory disposal, isolation fallback, and cold-load budgets against Spec 02.

[`g4stein/suture-crew`](https://github.com/g4stein/suture-crew) ships three more as a Kiro Crew app:
- **Schema Archaeologist** maps lineage;
- **Invariant Adversary** runs the Exorcist;
- **Formula Surgeon** proposes a fix, and recommends it only after `suture_verify_patch` proves it.

The app also includes two skills, a paused nightly cron, and a dashboard page.

## MCP: Suture as a tool Kiro can call

`packages/mcp` is a stdio MCP server, published as [`@g4stein/suture-mcp@0.1.0`](https://www.npmjs.com/package/@g4stein/suture-mcp). It answers both the 2025-11-25 `initialize` handshake and the stateless 2026-07-28 revision (`server/discover`). The workspace config `.kiro/settings/mcp.json` starts it for this repository.

| Tool | What it gives Kiro |
|---|---|
| `suture_list_workbooks` | the flagships and every `.suture.json` in the workspace |
| `suture_inspect_lineage` | a cell's dialect, formula, precedents, dependents, and full topological chain |
| `suture_run_audit` | a real Exorcist run: Tier 1 and Tier 2 verdicts, shrunk inputs, failing lineage, and a replay artifact |
| `suture_verify_patch` | applies one or more formula patches in memory, replays the counterexample, re-audits with the same seed, and reports `{ ok, seed, counterexampleFixed, freshAuditPassed, regressions, baseValueDiffs }` |

**What MCP made possible.** An agent can prove a spreadsheet fix instead of guessing at it.

For example, on Flagship 1 the stdio integration test (`packages/mcp/test/stdio.test.ts`) does three things:
1. It runs the audit and sees `runway-non-negative` fail.
2. It verifies the guarded patch `=IF(B4<=0,120,Inputs!B2/B4)`, which returns `ok: true` with zero regressions.
3. It confirms a no-op patch returns `ok: false`.

The Crew app's Formula Surgeon is built on that contract. Its CI installs the app with Kiro Crew's own installer and registrar (a pinned `kirodotdev/KiroCrew` commit), and runs the end-to-end proof against the published package with a cold `npx -y @g4stein/suture-mcp@0.1.0` (`suture-crew/.github/workflows/ci.yml`).

Security came from the same process: a probe showed that Python under Pyodide in Node can call `js.process.getBuiltinModule("fs")`. So headless hosts run `=PY()` only for the built-in flagships, or when the caller passes `trustPython` (Spec 05 §6, steering §7).

## Property-based testing

fast-check drives both the test suite and the product.
- **In the test suite:** parser round-trips, a differential oracle against an independent formula engine, non-finite leaks, determinism across edit order and tie-breaks, graph and cycle properties, and, since Phase 5, *the incrementally maintained dependency graph equals a rebuilt one* over 300 random edit batches.
- **In the product:** the Exorcist *is* property-based testing. It fuzzes declared inputs through DuckDB, NumPy, and formulas at once, shrinks failures, and replays them exactly.

`.kiro/audit/pbt-discoveries.md` logs five real defects. Two are shrunk property counterexamples a unit test would not have targeted:
- **`AA(#N/A/FALSE)`** (seed `20261120`): the lexer swallowed an error literal followed by `/`, so a printed formula no longer parsed.
- **`MOD(1, -3)`**: the differential oracle showed the result must be `-2`, and Suture's kernel had the wrong sign.

The other three were found by real-engine tests and measurements:
- **exceljs:** it rewrote quoted sheet names in shared formulas.
- **Float sampling:** `fc.double` starved the upper part of float domains, about 20× less often than value-uniform sampling. The Exorcist now samples uniformly.
- **A CI-only race:** a Pyodide interrupt signal was lost. The client now re-asserts it until the worker settles.

## Kiro powers

Not used. Suture's domain expertise is packaged in its own steering, specs, agents, and MCP server.
