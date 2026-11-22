# Tasks: X-Ray UI & Flagship Workbooks

Unit tests run with `npx vitest --run` in `packages/web` (and the real-engine tests in `packages/runtime`). End-to-end tests run with Playwright on Chromium, and on WebKit where a task says so. Do not use watch mode. Every e2e test that checks Req 1.5 registers a `PerformanceObserver` for `longtask` and fails on any task over 50 ms (scoped to scrolling, typing, and X-Ray rendering, steering §3; `e2e/app.ts` `withinFrameBudget`).

Phase 4 commits on `feat/xray-studio-ui`: 68bccbb (palette, command bar, readiness pill, store), 1314edf (grid, formula bar), f30f2fa (inspector, drawer, slice retired), 945de70 (X-Ray), 89b607e (Exorcist Audit Studio), 5ea37ff (drag-and-drop, trademark scan), 406c315 (journeys).

- [x] 1. App shell and state
  - [x] 1.1 Create `packages/web` (Vite, React, Tailwind) with the steering design tokens in the Tailwind theme and a check banning hex colors in `src/**/*.tsx`.
    - Verify: a component with a hex color fails the check; the tokens resolve and meet contrast.
    - _Requirements: 11.1_
    - Evidence: 68bccbb — `test/hexColors.test.ts` (a Vitest source scan replaces the ESLint rule, so no lint dependency is added) and `test/contrast.test.ts` (Phase 4 palette values; every text token ≥ 4.5:1 on every surface).
  - [x] 1.2 Implement `AppStore`, `Action` handling, and the main-thread `WorkbookEngine` with `sliceMs: 8` and a `MessageChannel` `yieldControl`.
    - Verify: a 20,000-formula sheet recalculates with no long task over 50 ms; edits produce the expected snapshots.
    - _Requirements: 1.5; Spec 01 Req 10.7_
    - Evidence: 68bccbb — `app/store.ts`; Journeys 1–3 (406c315) find no task over 50 ms while scrolling, typing, or rendering X-Ray.
    - Evidence (Phase 5): 354e0c1 (incremental graph, sliced preamble) and aa49a8f (the store re-indexes only edited cells; large tables tracked from commit events). The `test.fixme` is removed. In `e2e/journeys.spec.ts`, editing the input of 20,000 formulas runs with 0 main-thread tasks over the unchanged 50 ms limit (5 of 5 local repeats; warm recalculation 103–117 ms).

- [x] 2. Grid
  - [x] 2.1 Implement `grid/viewport.ts` (scaling, prefix sums, `visibleWindow`, `cellRect`).
    - Verify: unit tests cover row 1,048,575 being reachable at maximum scroll, overscan bounds, `colAt` at width boundaries, and content height ≤ 8,000,000 px.
    - _Requirements: 1.1, 1.2_
    - Evidence: 1314edf — `test/viewport.test.ts` (6 tests, including a property that `scrollTopForRow` inverts `firstRowExact`).
  - [x] 2.2 Implement `GridViewport` and `CellLayer` with value formatting and badges.
    - Verify: tests cover 12-significant-digit display, exponent thresholds, errors in `fracture` color, pending indicators, and table / matrix badges; an e2e flings through 1,048,576 rows with no long task.
    - _Requirements: 1.1, 1.2, 1.4, 1.5_
    - Evidence: 1314edf, f30f2fa — `grid/Grid.tsx`, `grid/CellView.tsx`, `test/ui.test.ts` (display); Journey 3 fling to row 1,048,576 inside the frame budget (406c315).
  - [x] 2.3 Implement keyboard navigation, edit-on-type, clearing, and the ARIA roles.
    - Verify: an e2e covers each key in Req 1.3; targeted ARIA checks (`role="grid"`, `aria-rowcount`, `role="row"`/`gridcell`, `aria-selected`).
    - _Requirements: 1.3, 1.6, 11.3_
    - Evidence: 1314edf; Journey 3 covers every Req 1.3 key, type-to-edit, Delete, and `aria-rowcount`. `axe-core` is MPL-2.0 and not allowed by the license policy, so it is not used.

- [x] 3. Formula bar and inspector
  - [x] 3.1 Implement `FormulaBar` (name box navigation, commit and cancel, multi-line mode for `=SQL(`/`=PY(`).
    - Verify: an e2e covers name-box navigation to `Margins!B5` and to a defined name, Escape discarding the draft, and Shift+Enter inserting a newline in a `=PY(` draft.
    - _Requirements: 2.1–2.4_
    - Evidence: 1314edf — `grid/FormulaBar.tsx`; every journey navigates with the name box; Journey 3 covers the multi-line `=PY(` draft, Shift+Enter, and Escape.
    - Evidence (Phase 5): aa49a8f — the 20,000-formula test's document defines `Driver` → `Load!A1`; typing `driver` in the name box selects `Load!A1` (`aria-selected`).
  - [x] 3.2 Implement `CellInspector` (dialect and engine badge, error details with an origin link, a 100-row `TableRef` preview, a `Matrix2D` table, precedents and dependents, assertions).
    - Verify: inspecting `Orders!A1` in flagship 2 decodes only 100 rows (instrumented row counter); clicking an error origin selects it.
    - _Requirements: 3.1–3.5_
    - Evidence: f30f2fa — `inspector/CellInspector.tsx`, `inspector/preview.ts`; `test/ui.test.ts` (100 of 100,000 rows decoded); Journey 2 (`data-decoded="100"`, 100 rows); Journey 4 (error origin link).

- [ ] 4. Readiness pill
  - [ ] 4.1 Implement `engineLabel` and `ReadinessPill` with the popover and Retry.
    - Verify: a unit test maps every `EngineState` per design §4; an e2e on a fresh page shows `Grid: Ready | DuckDB: Lazy | Python/NumPy: Lazy`, then `Loading` and `Ready` after the first `=SQL()`; an unisolated page shows `Degraded (restart on timeout)` for both engines with the full reason in the accessible name; after a crash respawn the label goes `Loading` → `Ready`, never back to `Lazy`; a known-length download shows a percentage and an unknown-length one does not.
    - _Requirements: 4.1–4.6_
    - Evidence: 68bccbb — `chrome/ReadinessPill.tsx`, `test/ui.test.ts` (every state, the colon form, percentage only with a known total, accessible name with reason); Journey 3 (Blank: both Lazy, then `Loading → Ready`, never back to Lazy; telemetry popover fields).
    - Evidence (Phase 5): aa49a8f and the docs commit — `e2e/journeys.spec.ts` "Req 4.1" opens the app page without COOP/COEP. Both engines start `Lazy`, then each shows `Degraded (restart on timeout)` once it loads (DuckDB on the first `=SQL()`, Python on the first `=PY()`), with the full reason in the pill's accessible name, `crossOriginIsolated: false` and the degraded note in the popover, and both cells evaluate.
    - Status: Partial. The post-crash label sequence (`Loading` → `Ready`, never `Lazy`) is still covered only at the engine level (`e2e/hardening.spec.ts`), not on the app page.

- [x] 5. X-Ray
  - [x] 5.1 Implement `xray/geometry.ts` (`threadCurve`, `splitAt`, `brokenThread`).
    - Verify: property tests show `splitAt` halves reproduce the original curve points (within 1e-9 px), the gap arc length is 6 ± 0.1 px, and control offsets are clamped to [40, 240].
    - _Requirements: 5.1, 5.5_
    - Evidence: 945de70 — `test/geometry.pbt.test.ts` (4 properties).
  - [x] 5.2 Implement `computeXRayFrame` with the 1,500 cap, the hidden count, fractured and broken flags, portals, dimming, and memoization.
    - Verify: a 10,000-edge workbook yields ≤ 1,500 threads and the correct `hidden`; scrolling inside the window does not recompute.
    - _Requirements: 5.3, 5.4, 5.8–5.10_
    - Evidence: 945de70 — `test/xrayFrame.test.ts`; Journey 1 asserts `data-frame-id` is unchanged after a scroll inside the rendered window (406c315).
  - [x] 5.3 Implement `XRayOverlay` (engine colors and dashes, arrowheads, flow highlight, pulse, reduced motion, accessible clickable fracture), callouts, and the lineage strip.
    - Verify: an e2e checks stroke and dash attributes per engine; with `reducedMotion: 'reduce'`, the computed `animation-name` is `none`; clicking or pressing Enter on a fractured path opens the counterexample; lineage steps and portals jump to their sheet.
    - _Requirements: 5.1, 5.2, 5.5–5.7, 5.11, 5.12_
    - Evidence: 945de70; Journey 1 (formula solid, Python dotted stub, arrowheads, `suture-pulse` → `none` under reduced motion, Enter opens the verdict); Journey 2 (SQL dashed, fractured portals, lineage-step and portal jumps, callouts).

- [x] 6. Bring your own data
  - [x] 6.1 Implement `importKind`, size limits, `sanitizeDatasetName`, `validateDocument`, and routing.
    - Verify: unit tests cover each rejection path in Req 6.4 and the `.suture.json` detection.
    - _Requirements: 6.3, 6.4_
    - Evidence: 68bccbb — `import/routeFile.ts`, `import/validateDocument.ts`; `test/ui.test.ts` (unsupported type, oversize, JSON paths for an invalid kind and an inverted domain); `test/ingest.test.ts` (`sanitizeDatasetName`).
  - [x] 6.2 Implement CSV, Parquet, and XLSX import with the import report, progress, and the drop zone.
    - Verify: an e2e drops a CSV and queries it with `=SQL()`; an `.xlsx` gives the expected sheets, datasets, error counts, and warnings.
    - _Requirements: 6.1, 6.2, 6.6_
    - Evidence: cae91a1, 307f680, 5ea37ff — `chrome/DropOverlay.tsx`; Journey 3 (synthetic drag-and-drop of a real CSV, `=SQL()` and `=PY()` over it); Journey 4 and `e2e/ingest.spec.ts` (real `.xlsx`, `#NAME?` count, no uploads).
  - [x] 6.3 Implement `gatedPyEngine` and the trust banner.
    - Verify: opening an imported file with `=PY()` makes no Pyodide network request and shows the exact blocked message; trusting recalculates and evaluates the cells.
    - _Requirements: 6.5_
    - Evidence: 68bccbb — `engines/gatedPy.ts`, `chrome/Banners.tsx`; `test/ui.test.ts` (inner engine never called); Journey 4 (`.xlsx` with `=PY()`: `#PY!` with the exact message, Pyodide `notLoaded`, no `pyodide.asm.wasm` request, Exorcise disabled, Trust evaluates to 4); Journey 4 fresh page (`.suture.json` Python is untrusted again, and the replay waits for Trust).

- [x] 7. Exorcist panel and replay
  - [x] 7.1 Implement the Exorcist Audit Studio (start/stop, mode, seed, progress, Tier 1 and Tier 2 status, verdict card, action bar, assertion and domain editor) and stale marking.
    - Verify: an e2e on flagship 1 shows a violated verdict with all fields; editing during a session marks it stale; the downloaded file parses with `isReplayArtifact`.
    - _Requirements: 7.1, 7.2, 7.5_
    - Evidence: 89b607e — `exorcist/AssertionsTab.tsx`, `exorcist/AuditTab.tsx`; Journey 1 (verdict, Tier 1 held, Tier 2 violated, Apply, Reset); Journey 2 (mid-session edit → `stale`); Journey 4 (custom domain and assertion, downloaded replay accepted by `isReplayArtifact` on import).
  - [x] 7.2 Implement `#replay=v1.` handling and replay files: built-in lookup by hash, a prompt for other documents, and the replay outcome display with X-Ray highlight.
    - Verify: opening a copied link in a fresh context reproduces the violation as `exact`; a replay for an unknown hash prompts for a document; a corrupted link shows the decode error.
    - _Requirements: 7.3, 7.4_
    - Evidence: 89b607e, 406c315 — Journey 1 (clipboard link in a fresh page: `replay: reproduced (exact)`, identical shrunk inputs, fracture rendered); Journey 4 (replay JSON → prompt → `.suture.json` → exact); Journey 5 (corrupted link → `replay link: …`).

- [x] 8. Flagship workbooks
  - [x] 8.1 Author `workbooks/saasRunway.ts` per design §7.1; built-in hashes are computed at runtime with `workbookHash`.
    - Verify: a test against real engines checks that all assertions hold at the base case and that the session mode is `batched`.
    - _Requirements: 8.1–8.5_
    - Evidence: 746416e — authored as `packages/web/src/workbooks/saasRunway.ts` (typed module instead of JSON); built-in hashes are computed at runtime over the canonical definition.
  - [x] 8.2 Author `workbooks/ecommerceMargin.ts` per design §7.2.
    - Verify: a test against real engines checks that all base-case assertions hold and that the session mode is `batched`; `Orders!A1` and `Segments!A1` do not depend on `Params`.
    - _Requirements: 9.1–9.8_
    - Evidence: 746416e — `packages/web/src/workbooks/ecommerceMargin.ts`; 100,000 rows synthesized once, cached upstream of Params.

- [ ] 9. Genuine discovery tests
  - [x] 9.1 Add the estimation and control tests (design §8) for both flagships.
    - Verify: the failing fraction is ≥ 1% with the shipped formulas, and there are zero violations of the expected assertion with the corrected formulas, for each flagship.
    - _Requirements: 10.3, 10.4_
    - Evidence: 746416e — `test/flagships.test.ts` (estimation ≥ 1 %, control 0 %, both flagships).
  - [x] 9.2 Add `flagships.spec.ts`, which runs with a fresh random seed, logs it, and checks the expected assertion id and exact replay.
    - Verify: the test passes on 20 consecutive CI runs; a review checklist item confirms the file contains no input values or seeds.
    - _Requirements: 10.1, 10.2_
    - Evidence: 746416e, 307f680, 406c315 — `test/flagships.test.ts` (Node, real engines) and `e2e/flagships.spec.ts` (browser, moved to the Phase 4 UI), fresh random seeds, exact replay.
    - Status: the 20-consecutive-CI-runs count is still accumulating (PR #4 ended with 3 consecutive green attempts).

- [x] 10. Trademark check
  - [x] 10.1 Add the digest-based trademark scan (design §9).
    - Verify: the scanner, run with an in-memory digest list that adds the digest of a made-up word, fails on a temporary file containing that word (the file is created and deleted inside the test); the real digest list passes on the clean repository. No banned term is ever written by the test.
    - _Requirements: 11.2_
    - Evidence: 5ea37ff — `test/trademark.test.ts`, `test/fixtures/trademark.ts`, `test/fixtures/banned-term-digests.json`; Journey 5 runs the scanner on the rendered DOM for all three workbooks.

- [x] 11. Narrow viewports and caching
  - [x] 11.1 Lay out below 768 px without horizontal page overflow, keep Exorcise Model reachable, and show the desktop banner; serve hashed assets as immutable with no service worker.
    - Verify: an e2e at 390×844 measures zero horizontal overflow for all three workbooks and runs and stops a session; `vercel.json` sets `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` only.
    - _Requirements: 11.4, 11.5_
    - Evidence: 68bccbb (`vercel.json`, banner), f30f2fa (stacked layout, bottom-sheet studio); Journey 5 (406c315).

- [x] 12. First-impression polish (code-freeze PR)
  - [x] 12.1 Paint the obsidian loading shell from `index.html` and land built-in flagships on their live KPI cell.
    - Verify: Journey 5 holds back the app bundle and sees the shell (SUTURE, "Initializing local engines…", `role=status`, `rgb(9, 11, 16)` on html and the shell), then the app replaces it with no console error. Journeys 1 and 2 open on `Model!B5` / `Margins!B5` with the sheet tab, the cell, and the Cell tab selected.
    - _Requirements: 2.5, 11.6_
    - Evidence: 0adc4e2 — `index.html`, `app/store.ts` (`landing`), `e2e/app.ts` (`expectLanding`), `e2e/journeys.spec.ts`.
  - [x] 12.2 Format grid numbers with `formatGridNumber` and expose `data-raw`.
    - Verify: unit tests cover separators, the 2-decimal and 4-significant-digit rules, the exponent thresholds, and both zeros; `cellDisplay` keeps the 12-digit tooltip and the raw value. E2E value checks read `data-raw`.
    - _Requirements: 1.4_
    - Evidence: 0adc4e2 — `test/ui.test.ts`, `grid/cellDisplay.ts`, `grid/CellView.tsx`.


- [x] 13. Final judge polish (code-freeze PR)
  - [x] 13.1 Ship the Suture Crew sample as a built-in so Crew replay links open with no import.
    - Verify: `runtime/test/wholesaleQuote.test.ts` pins the built-in's canonical hash to the Crew fixture's `workbookHash`; the E2E "Req 7.6" opens the real Crew fixture link and sees `replay: reproduced (exact)`, no replay prompt, X-Ray on, the violated cell's sheet, and the fractured `Pricing` portal.
    - _Requirements: 7.6_
  - [x] 13.2 Keep the command bar on one row from 1280 px, move the full title to the tab and the picker's tooltip, and print assertion operators in ASCII (`>=`, `<=`), which every monospace font has.
    - Verify: the flagship E2E tests check the tab title; the shared `assertionLabel` prints `>= 0`.
    - _Requirements: 11.7_
  - [x] 13.3 Run the judge path in WebKit and Firefox.
    - Verify: `e2e/browsers.spec.ts` runs in the `webkit` and `firefox` Playwright projects in CI: the landing KPI evaluates, Exorcise Model finds `runway-non-negative`, Apply trips it, and the X-Ray fracture draws, with the readiness pill `degraded` where the browser is not cross-origin isolated.
    - _Requirements: 11.8_
