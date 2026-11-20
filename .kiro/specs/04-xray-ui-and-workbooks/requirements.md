# Requirements: X-Ray UI & Flagship Workbooks

## Introduction

This spec defines the `packages/web` user interface: the virtualized grid, formula bar, cell inspector, Engine Readiness Pill, X-Ray lineage overlay, Exorcist panel, bring-your-own-data import, and the two preloaded flagship workbooks. It obeys `.kiro/steering/ui-craft-and-branding.md` (tokens, X-Ray rules, readiness states, trademark hygiene) and `.kiro/steering/architecture-and-isolation.md`.

It uses these types unchanged:
- **Spec 01:** `CellKey`, `CellValue`, `CellError`, `EngineId`, `WorkbookEngine`, `WorkbookDefinition`, `Edit`, `DatasetMeta`, `PyEngine`.
- **Spec 02:** `EngineHost`, `EngineStatus`, `EngineState`, `EngineName`, `XlsxIngestResult`, `SqlBridge`, `PyBridge`.
- **Spec 03:** `SutureDocument`, `ReplayArtifact`, `ReplayOutcome`, `LineagePath`, `LineageEdge`, `ExorcistVerdict`, `ExorcistProgress`, `ValueSummary`, `CellAssertion`, `FuzzInput`, `ExorcistConfig`, `Hasher`, `ExorcistCommand`, `ExorcistEvent`.

## Requirements

### Requirement 1: Virtualized grid

**User Story:** As a modeler, I want a fast, keyboard-driven grid, so that large sheets feel instant.

#### Acceptance Criteria
1. THE SYSTEM SHALL render only the visible rows and columns plus an overscan of 4 rows and 2 columns.
2. THE SYSTEM SHALL support sheets up to 1,048,576 rows and 16,384 columns, scaling the scroll extent so that no scroll container exceeds 8,000,000 px.
3. THE SYSTEM SHALL support arrow-key, Tab, Shift+Tab, Enter, Shift+Enter, Page Up/Down, and Ctrl/Cmd+Home navigation, typing to start editing, and Delete/Backspace to clear.
4. THE SYSTEM SHALL display numbers right-aligned in tabular monospace figures with up to 12 significant digits, errors as their code in the `fracture` color, pending engine cells with a pending indicator, and `TableRef` and `Matrix2D` cells as a compact badge (`table 100,000×10`, `matrix 1×2`).
5. WHILE the user scrolls, types, or selects, THE SYSTEM SHALL keep every main-thread task under 50 ms.
6. THE SYSTEM SHALL expose the grid with `role="grid"`, `aria-rowcount`, `aria-colcount`, and `aria-selected` on the active cell.

### Requirement 2: Formula bar

**User Story:** As a modeler, I want to see and edit any cell's source, including multi-line SQL and Python.

#### Acceptance Criteria
1. WHEN a cell is selected, THE SYSTEM SHALL show its `CellKey` in the name box and its raw source in the formula bar.
2. WHEN the user types a valid reference or defined name in the name box and presses Enter, THE SYSTEM SHALL select that cell or range.
3. WHEN the user presses Enter in the formula bar, THE SYSTEM SHALL commit a `setCell` edit, and WHEN the user presses Escape, THE SYSTEM SHALL discard the draft.
4. WHILE the draft starts with `=SQL(` or `=PY(`, THE SYSTEM SHALL expand the formula bar to a monospace multi-line editor of up to 12 visible lines, where Shift+Enter inserts a newline.

### Requirement 3: Cell inspector

**User Story:** As a modeler, I want to understand any cell at a glance: what it is, what it depends on, and why it failed.

#### Acceptance Criteria
1. WHEN a cell is selected, THE SYSTEM SHALL show its dialect, its engine badge in the engine color, its raw source, and its current value or pending state.
2. WHEN the value is a `CellError`, THE SYSTEM SHALL show the code, the message, the engine, and the `origin` cell as a link that selects it.
3. WHEN the value is a `TableRef`, THE SYSTEM SHALL show the schema and a preview of at most the first 100 rows, decoding only those rows on the main thread.
4. WHEN the value is a `Matrix2D`, THE SYSTEM SHALL show its values in a scrollable table.
5. THE SYSTEM SHALL list precedents and dependents as links, and the assertions attached to the cell, each with its status from the latest finished session: `violated` (it is the artifact's assertion), `held` (the session passed), or `not reached` (the session stopped at another assertion's violation or was stopped).

### Requirement 4: Engine Readiness Pill

**User Story:** As a user, I want to know honestly what is loaded, so that I understand any wait.

#### Acceptance Criteria
1. THE SYSTEM SHALL show one pill with three segments in the form `Grid Ready | DuckDB <label> | Python/NumPy <label>`.
2. THE SYSTEM SHALL show the Grid segment as `Ready` once the grid is interactive.
3. THE SYSTEM SHALL map each `EngineState` to a label: `notLoaded` → `Lazy`, `loading` → `Loading` (with a percentage only when `totalBytes` is known), `ready` → `Ready`, `degraded` → `Degraded (<short reason>)`, `failed` → `Failed`.
4. WHEN the user opens a segment, THE SYSTEM SHALL show the full `EngineStatus.reason`, the crash count, and a Retry action for `failed` engines.
5. THE SYSTEM SHALL NOT show `Lazy` for an engine that is loading, and SHALL NOT show a percentage the loader did not report.
6. THE SYSTEM SHALL color each segment with its engine token (`engine-sql` for DuckDB, `engine-py` for Python/NumPy) and SHALL include the full label and reason in its accessible name.

### Requirement 5: X-Ray lineage overlay

**User Story:** As an auditor, I want to see how values flow between engines and exactly where a counterexample breaks.

#### Acceptance Criteria
1. WHEN X-Ray Mode is on, THE SYSTEM SHALL draw a cubic bezier thread from each precedent to each dependent on a single SVG overlay above the grid.
2. THE SYSTEM SHALL color each thread by the dependent cell's engine (SQL cyan, Python amber, Formula emerald) and give it that engine's dash pattern (SQL dashed, Python dotted, Formula solid).
3. THE SYSTEM SHALL draw threads only where at least one endpoint lies within the viewport expanded by one viewport size in each direction, up to 1,500 threads.
4. IF more than 1,500 threads qualify, THEN THE SYSTEM SHALL draw only the threads touching the selected cell or the active lineage, and show a chip stating how many threads are hidden.
5. WHEN an Exorcist verdict is `violated`, THE SYSTEM SHALL draw the artifact's lineage edges in `fracture` crimson, render the `failingEdge` as a broken thread with a gap at its midpoint, and pulse those edges.
6. WHILE `prefers-reduced-motion: reduce` is set, THE SYSTEM SHALL show the fracture as a static crimson highlight.
7. WHEN the user clicks a fractured thread, THE SYSTEM SHALL open the counterexample in the Exorcist panel.
8. THE SYSTEM SHALL recompute thread geometry only when the visible window, the layout, the dependency graph, or the lineage changes.

### Requirement 6: Bring your own data

**User Story:** As an analyst, I want to drop in real files and start working immediately.

#### Acceptance Criteria
1. WHEN the user drops or picks a `.csv` or `.parquet` file, THE SYSTEM SHALL register it through `EngineHost.registerDataset` and apply a `registerDataset` edit with the returned `DatasetMeta`.
2. WHEN the user drops or picks an `.xlsx` file, THE SYSTEM SHALL ingest it through `EngineHost.ingestXlsx`, add each sheet as a Suture sheet (renaming on collision), register each sheet table as a dataset through `EngineHost.registerDataset` (source format `xlsx`, encoding `arrow`), and show an import report with the number of cells that evaluate to `#NAME?` or `#VALUE!` and every ingest warning.
3. WHEN the user drops or picks a `.suture.json` file, THE SYSTEM SHALL validate it as a `SutureDocument` and open it.
4. IF a file is larger than 256 MiB, has an unsupported extension, or fails validation, THEN THE SYSTEM SHALL reject it with a message naming the reason and SHALL leave the workbook unchanged.
5. WHEN a document that is not a built-in flagship contains `=PY()` cells, THE SYSTEM SHALL evaluate those cells to `#PY!` with the message "Python is blocked until you trust this workbook", until the user explicitly trusts the workbook.
6. WHILE an import is running, THE SYSTEM SHALL show its progress and keep the grid interactive.

### Requirement 7: Exorcist panel and replay links

**User Story:** As an auditor, I want to run the Exorcist, read its verdict, and share a link that reproduces it.

#### Acceptance Criteria
1. THE SYSTEM SHALL let the user start and stop an Exorcist session, and SHALL show the mode, the seed, live progress, and the verdict.
2. WHEN the verdict is `violated`, THE SYSTEM SHALL show the violated assertion (the expected rule), the observed value for Tier 2 or the invariant detail for Tier 1, the failing inputs, the lineage, and actions to copy the replay link, download the replay JSON, and show the lineage in X-Ray.
3. WHEN the page loads with a `#replay=v1.` fragment, THE SYSTEM SHALL decode it, open the built-in flagship whose hash matches `workbookHash`, or ask the user to open the matching `.suture.json`, and then run the replay.
4. WHEN a replay finishes, THE SYSTEM SHALL show whether it was exact or direct, and highlight the lineage in X-Ray.
5. IF the document changes during a session, THEN THE SYSTEM SHALL label the session's verdict as stale.

### Requirement 8: Flagship workbook 1, SaaS Cash Runway & Unit Economics

**User Story:** As a founder, I want a realistic runway model that shows how a base-case spreadsheet hides a cliff.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship the document `saas-runway.suture.json` with the input, model, fuzz-domain, and assertion layout in `design.md` §7.1.
2. WHEN the document is opened, THE SYSTEM SHALL show base-case values in which every assertion holds.
3. THE SYSTEM SHALL compute runway as cash divided by net burn, the realistic modeling flaw this workbook contains, so that net burn at or below zero produces `#DIV/0!` or a negative runway.
4. THE SYSTEM SHALL run this workbook's Exorcist session in in-process mode.

### Requirement 9: Flagship workbook 2, 100,000-Row E-Commerce Margin Audit

**User Story:** As a finance lead, I want an end-to-end cross-engine audit that finds a discount-stacking bug base cases hide.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship the document `ecommerce-margin.suture.json` with the sheets, SQL, Python, formulas, fuzz domains, and assertions in `design.md` §7.2.
2. THE SYSTEM SHALL synthesize the 100,000-row order dataset inside DuckDB from `range(100000)` and the deterministic `suture_u01` / `suture_normal` macros, so that every load produces bit-identical data.
3. THE SYSTEM SHALL compute segment margins in `=SQL()`, fit an OLS margin model and count residual anomalies in `=PY()` with NumPy, and derive the executive KPIs with `SUMIFS`, `SUM`, `INDEX`, and `IF`.
4. THE SYSTEM SHALL apply the discount cap to each discount separately rather than to the stacked total, the realistic implementation flaw this workbook contains.
5. WHEN the document is opened, THE SYSTEM SHALL show base-case values in which every assertion holds.
6. THE SYSTEM SHALL run this workbook's Exorcist session in batched mode.

### Requirement 10: Genuine bug discovery in CI

**User Story:** As a judge, I want proof that the bugs are found by search, not scripted.

#### Acceptance Criteria
1. THE SYSTEM SHALL include a CI test that, for each flagship, runs an Exorcist session with a fresh random seed, logs the seed, and passes only when the verdict is `violated` on the expected assertion id and the artifact replays as `exact`.
2. THE SYSTEM SHALL keep failing input values, expected counterexamples, and seeds out of the flagship documents and tests. Tests may assert only assertion ids, verdict kinds, and replay outcomes.
3. THE SYSTEM SHALL include a deterministic estimation test showing that each flagship's failing region covers at least 1% of its fuzz domain under uniform sampling. At that rate, a run of uniform draws misses the region with probability below 1e-4 for flagship 1 (1,000 runs, 0.99^1000 ≈ 4.3e-5) and below 1e-8 for flagship 2 (2,000 runs, 0.99^2000 ≈ 1.9e-9). fast-check's edge bias replaces some uniform draws with draws near the domain bounds. Both flaws sit at a corner of their domains, so the bias is expected to raise the hit rate. The CI test (10.1) checks the real rate.
4. THE SYSTEM SHALL include a control test that applies the corrected formula (`design.md` §7.1 and §7.2) as an edit and shows zero violations of the expected assertion over the same sampled scenarios, proving that the flaw causes the failure.

### Requirement 11: Branding, trademark hygiene, and accessibility

**User Story:** As the project owner, I want a consistent, compliant, accessible product.

#### Acceptance Criteria
1. THE SYSTEM SHALL take every color from the steering design tokens, and SHALL contain no hard-coded hex colors in components.
2. THE SYSTEM SHALL include a CI check that fails when UI copy, docs, comments, or identifiers contain a banned third-party spreadsheet product name, matching against SHA-256 hashes of the banned terms so that the terms themselves never appear in the repository.
3. THE SYSTEM SHALL meet WCAG AA contrast for body text, and SHALL make every action reachable by keyboard.
