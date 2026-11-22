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
3. THE SYSTEM SHALL support arrow-key, Tab, Shift+Tab, Enter, Shift+Enter, Page Up/Down, Ctrl/Cmd+Home, and Ctrl/Cmd+End navigation, typing to start editing (every printable key, including `x`), F2 and double-click to edit, and Delete/Backspace to clear.
4. THE SYSTEM SHALL display numbers in grid cells right-aligned in tabular monospace figures with thousand separators, at most 2 decimals when |n| ≥ 1 and 4 significant digits when |n| < 1 (exponent notation outside `[1e-6, 1e15)`), SHALL show the value to 12 significant digits in the cell tooltip and the inspector and keep the raw value in the formula bar, the editor, and every stored value, and SHALL show errors as their code in the `fracture` color, pending engine cells with a pending indicator, and `TableRef` and `Matrix2D` cells as a compact badge (`table 100,000×10`, `matrix 1×2`).
5. WHILE the user scrolls, types, or selects, THE SYSTEM SHALL keep every main-thread task under 50 ms.
6. THE SYSTEM SHALL expose the grid with `role="grid"`, `aria-rowcount`, `aria-colcount`, and `aria-selected` on the active cell.

### Requirement 2: Formula bar

**User Story:** As a modeler, I want to see and edit any cell's source, including multi-line SQL and Python.

#### Acceptance Criteria
1. WHEN a cell is selected, THE SYSTEM SHALL show its `CellKey` in the name box and its raw source in the formula bar.
2. WHEN the user types a valid reference or defined name in the name box and presses Enter, THE SYSTEM SHALL select that cell or range.
3. WHEN the user presses Enter in the formula bar, THE SYSTEM SHALL commit a `setCell` edit, and WHEN the user presses Escape, THE SYSTEM SHALL discard the draft.
4. WHILE the draft starts with `=SQL(` or `=PY(`, THE SYSTEM SHALL expand the formula bar to a monospace multi-line editor of up to 12 visible lines, where Shift+Enter inserts a newline.
5. WHEN a built-in flagship opens, THE SYSTEM SHALL activate its model sheet and select its primary KPI cell (Flagship 1 `Model!B5`, Flagship 2 `Margins!B5`) with the Cell inspector open; the Blank Workbook and imported files SHALL open on their first sheet at `A1`.

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
1. THE SYSTEM SHALL show one pill with three segments in the form `Grid: Ready | DuckDB: <label> | Python/NumPy: <label>`, with a popover that shows `crossOriginIsolated`, the SQL validator, cold boot per engine, first and warm evaluation time, and dataset and large-table row counts.
2. THE SYSTEM SHALL show the Grid segment as `Ready` once the grid is interactive.
3. THE SYSTEM SHALL map each `EngineState` to a label: `notLoaded` → `Lazy`, `loading` → `Loading` (with a percentage only when `totalBytes` is known), `ready` → `Ready`, `degraded` → `Degraded (<short reason>)`, `failed` → `Failed`.
4. WHEN the user opens the pill, THE SYSTEM SHALL show the full `EngineStatus.reason`, the crash count, and a Retry action for `failed` engines, and, when the page is not cross-origin isolated, explain the consequence based on `crossOriginIsolated` alone (no browser detection).
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
8. THE SYSTEM SHALL recompute thread geometry only when the visible window, the layout, the dependency graph, the selection, or the lineage changes.
9. THE SYSTEM SHALL draw a static arrowhead at the dependent end of every thread, SHALL animate a flow highlight only on threads touching the selection (at most 64), and SHALL dim cells outside the focus: the lineage when one is active, else the selection and its direct precedents and dependents, else all connected cells.
10. THE SYSTEM SHALL show one sheet-portal badge per connected sheet (direction and edge count) at the grid edge, and a click SHALL switch to that sheet and select the linked cell.
11. WHEN an Exorcist verdict is `violated` or a replay reproduces, THE SYSTEM SHALL enable X-Ray, switch to the violated cell's sheet, show callout pills with the shrunk input, each engine's intermediate value under the counterexample (computed without changing the workbook), and the violated assertion, and show a lineage strip whose step chips switch to their sheet and select their cell.
12. THE SYSTEM SHALL toggle X-Ray with Alt+X (Option+X) anywhere, and with a bare X only when focus is outside the grid and text inputs.

### Requirement 6: Bring your own data

**User Story:** As an analyst, I want to drop in real files and start working immediately.

#### Acceptance Criteria
1. WHEN the user drops a file anywhere on the window, or picks one with Import File, and it is a `.csv` or `.parquet` file, THE SYSTEM SHALL register it through `EngineHost.registerDataset`, apply a `registerDataset` edit with the returned `DatasetMeta`, and open its preview.
2. WHEN the user drops or picks an `.xlsx` file, THE SYSTEM SHALL ingest it through `EngineHost.ingestXlsx`, add each sheet as a Suture sheet (renaming on collision), register each sheet table as a dataset through `EngineHost.registerDataset` (source format `xlsx`, encoding `arrow`), and show an import report with the number of cells that evaluate to `#NAME?` or `#VALUE!` and every ingest warning.
3. WHEN the user drops or picks a `.suture.json` file, THE SYSTEM SHALL validate it as a `SutureDocument` and open it; WHEN the file is a replay `.json`, THE SYSTEM SHALL validate it with `isReplayArtifact` and hydrate it as in Req 7.3.
4. IF a file is larger than 256 MiB, has an unsupported extension, or fails validation, THEN THE SYSTEM SHALL reject it with a message naming the reason and SHALL leave the workbook unchanged.
5. WHEN any imported file (a `.suture.json` that is not a built-in flagship, or an `.xlsx`) brings in `=PY()` cells, THE SYSTEM SHALL evaluate those cells to `#PY!` with the message "Python is blocked until you trust this workbook" without starting Pyodide, show a non-blocking trust banner while formulas and SQL keep running, and disable Exorcise Model, until the user explicitly trusts the workbook.
6. WHILE an import is running, THE SYSTEM SHALL show its progress and keep the grid interactive.

### Requirement 7: Exorcist panel and replay links

**User Story:** As an auditor, I want to run the Exorcist, read its verdict, and share a link that reproduces it.

#### Acceptance Criteria
1. THE SYSTEM SHALL let the user start (Exorcise Model) and stop an Exorcist session, and SHALL show the execution mode (In-Process fast-check or Batched WASM), the seed, runs, scenarios evaluated, shrink rounds, elapsed time, Tier 1 invariant status, Tier 2 assertion status, and the verdict.
2. WHEN the verdict is `violated`, THE SYSTEM SHALL show the violated assertion (the expected rule), the violated cell, the observed value for Tier 2 or the invariant detail for Tier 1, the failing inputs, an **Apply Counterexample** action that applies `failingInputs` as `setLiteral` edits (lossless, Spec 01 §4) to the live workbook so the failing lineage recomputes and trips the assertion, **Reset Base Values**, **Focus in X-Ray**, **Copy Replay Link** (downloading the replay JSON instead above 8,192 characters), **Download Replay JSON**, **Export workbook (.suture.json)**, and **Import Replay JSON**.
3. WHEN the page loads with a `#replay=v1.` fragment, THE SYSTEM SHALL decode it, open the built-in flagship whose hash matches `workbookHash`, or ask the user to open the matching `.suture.json`, and then run the replay.
4. WHEN a replay finishes, THE SYSTEM SHALL show whether it was exact or direct, and highlight the lineage in X-Ray.
5. IF the document changes during a session, THEN THE SYSTEM SHALL label the session's verdict as stale.
6. THE SYSTEM SHALL ship the Suture Crew sample workbook (`g4stein/suture-crew` `samples/wholesale-quote.suture.json`) as a built-in with an identical workbook hash, so that WHEN a replay link produced by the Crew app is opened, THE SYSTEM SHALL open it on that built-in and replay it with no import prompt.

### Requirement 8: Flagship workbook 1, SaaS Cash Runway & Unit Economics

**User Story:** As a founder, I want a realistic runway model that shows how a base-case spreadsheet hides a cliff.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship the built-in document `workbooks/saasRunway.ts` with the input, cohort SQL, model, fuzz-domain, and assertion layout in `design.md` §7.1.
2. WHEN the document is opened, THE SYSTEM SHALL show base-case values in which every assertion holds.
3. THE SYSTEM SHALL compute runway as cash divided by the projected net burn, the realistic modeling flaw this workbook contains, so that a projected net burn at or below zero produces `#DIV/0!` or a negative runway.
4. THE SYSTEM SHALL compute the 12-month operating trajectory in `=SQL()` over a cached cohort table, project net burn with a NumPy least-squares fit in `=PY()`, and compute runway with a formula, and SHALL run this workbook's Exorcist session in batched mode with the assertions `runway-non-negative` (`gte` 0), `runway-defined` (`notError`), and `runway-finite` (`finite`).
5. THE SYSTEM SHALL let the Exorcist discover this flaw from a fresh seed in at most 3 s in the browser on the CI runner class.

### Requirement 9: Flagship workbook 2, 100,000-Row E-Commerce Margin Audit

**User Story:** As a finance lead, I want an end-to-end cross-engine audit that finds a discount-stacking bug base cases hide.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship the built-in document `workbooks/ecommerceMargin.ts` with the sheets `Params, Orders, Segments, Cohorts, Model, Margins` and the SQL, Python, formulas, fuzz domains, and assertions in `design.md` §7.2.
2. THE SYSTEM SHALL synthesize the 100,000-row order dataset inside DuckDB from `range(100000)` and the deterministic `suture_u01` / `suture_normal` macros, so that every load produces bit-identical data.
3. THE SYSTEM SHALL synthesize the orders once and aggregate them once into a tier table upstream of `Params`, so that no fuzz scenario re-scans the 100,000 rows.
4. THE SYSTEM SHALL compute segment margins in `=SQL()`, pivot them and fit a weighted OLS margin model with anomaly count in `=PY()` with NumPy, and derive the executive KPIs with `SUMIFS`, `SUM`, `AVERAGEIF`, `VLOOKUP`, `INDEX`, and `IF`.
5. THE SYSTEM SHALL apply the discount cap to each discount separately rather than to the stacked total, the realistic implementation flaw this workbook contains.
6. WHEN the document is opened, THE SYSTEM SHALL show base-case values in which every assertion holds.
7. THE SYSTEM SHALL run this workbook's Exorcist session in batched mode with the assertions `hardlines-stacked-net-margin` (`gte` 0), `total-margin-not-null` (`notNull`), and `model-projection-finite` (`finite`).
8. THE SYSTEM SHALL let the Exorcist discover this flaw from a fresh seed in 5–10 s in the browser on the CI runner class. This is a target, not a CI gate: the CI test asserts discovery and exact replay, not duration. Measured values are in `design.md` §7.3.

### Requirement 10: Genuine bug discovery in CI

**User Story:** As a judge, I want proof that the bugs are found by search, not scripted.

#### Acceptance Criteria
1. THE SYSTEM SHALL include a CI test that, for each flagship, runs an Exorcist session with a fresh random seed, logs the seed, and passes only when the verdict is `violated` on the expected assertion id and the artifact replays as `exact`.
2. THE SYSTEM SHALL keep failing input values, expected counterexamples, and seeds out of the flagship documents and tests. Tests may assert only assertion ids, verdict kinds, and replay outcomes.
3. THE SYSTEM SHALL include a deterministic estimation test showing that each flagship's failing region covers at least 1% of its fuzz domain under sampling that is uniform over values, using 1,000 samples per flagship. At 1%, a session of 1,000 uniform draws (10 batches of 100) misses the region with probability 0.99^1000 ≈ 4.3e-5. fast-check's edge bias replaces some uniform draws with draws near the domain bounds. Both flaws sit at a corner of their domains, so the bias is expected to raise the hit rate. The CI test (10.1) checks the real rate.
4. THE SYSTEM SHALL include a control test that applies the corrected formula (`design.md` §7.1 and §7.2) as an edit and shows zero violations of the expected assertion over the same sampled scenarios, proving that the flaw causes the failure.

### Requirement 11: Branding, trademark hygiene, and accessibility

**User Story:** As the project owner, I want a consistent, compliant, accessible product.

#### Acceptance Criteria
1. THE SYSTEM SHALL take every color from the steering design tokens, and SHALL contain no hard-coded hex colors in components.
2. THE SYSTEM SHALL include a CI check that fails when UI copy, docs, comments, or identifiers contain a banned third-party spreadsheet product name, matching against SHA-256 hashes of the banned terms so that the terms themselves never appear in the repository, and SHALL apply the same check to the rendered DOM.
3. THE SYSTEM SHALL meet WCAG AA contrast for body text, and SHALL make every action reachable by keyboard.
4. WHILE the viewport is narrower than 768 px, THE SYSTEM SHALL lay out without horizontal page overflow, keep Exorcise Model reachable, and show a banner that desktop is optimal.
5. THE SYSTEM SHALL serve hashed static assets as immutable for one year and SHALL NOT install a service worker, so COOP/COEP headers and deploys are never affected by a cached app shell.
6. THE SYSTEM SHALL paint an obsidian loading shell (the SUTURE wordmark and "Initializing local engines…", announced as a status) from the HTML alone, before any stylesheet or script loads, and SHALL replace it with the app on first render.
7. WHILE the viewport is at least 1280 px wide, THE SYSTEM SHALL keep the command bar on one row, and SHALL show the open workbook's full title in the browser tab and as the picker's tooltip rather than repeating it in the command bar.
8. THE SYSTEM SHALL complete the first-visit path (landing KPI evaluated through DuckDB, Pyodide, and formulas; Exorcise Model; Apply Counterexample; X-Ray fracture) in Chromium, WebKit, and Firefox, with WebKit in the degraded mode because it does not support COEP `credentialless`.
