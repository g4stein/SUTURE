# Tasks: X-Ray UI & Flagship Workbooks

Unit tests run with `npx vitest --run` in `packages/web`. End-to-end tests run with Playwright on Chromium, and on WebKit where a task says so. Do not use watch mode. Every e2e test that checks Req 1.5 registers a `PerformanceObserver` for `longtask` and fails on any task over 50 ms.

- [ ] 1. App shell and state
  - [ ] 1.1 Create `packages/web` (Vite, React, Tailwind) with the steering design tokens in the Tailwind theme and an ESLint rule banning hex colors in `src/**/*.tsx`.
    - Verify: a component with a hex color fails lint; the tokens resolve in a rendered snapshot.
    - _Requirements: 11.1_
  - [ ] 1.2 Implement `AppStore`, `Action` handling, `ValueStore`, and the main-thread `WorkbookEngine` with `sliceMs: 8` and a `MessageChannel` `yieldControl`.
    - Verify: a 20,000-formula sheet recalculates with no long task over 50 ms; edits produce the expected `ValueStore` snapshots.
    - _Requirements: 1.5; Spec 01 Req 10.7_

- [ ] 2. Grid
  - [ ] 2.1 Implement `grid/viewport.ts` (scaling, prefix sums, `visibleWindow`, `cellRect`).
    - Verify: unit tests cover row 1,048,575 being reachable at maximum scroll, overscan bounds, `colAt` at width boundaries, and content height ≤ 8,000,000 px.
    - _Requirements: 1.1, 1.2_
  - [ ] 2.2 Implement `GridViewport` and `CellLayer` with value formatting and badges.
    - Verify: tests cover 12-significant-digit display, exponent thresholds, errors in `fracture` color, pending indicators, and `table 100,000×10` / `matrix 1×2` badges; an e2e flings through 1,048,576 rows with no long task.
    - _Requirements: 1.1, 1.2, 1.4, 1.5_
  - [ ] 2.3 Implement keyboard navigation, edit-on-type, clearing, and the ARIA roles.
    - Verify: an e2e covers each key in Req 1.3; an axe scan reports no violations on the grid.
    - _Requirements: 1.3, 1.6, 11.3_

- [ ] 3. Formula bar and inspector
  - [ ] 3.1 Implement `FormulaBar` (name box navigation, commit and cancel, multi-line mode for `=SQL(`/`=PY(`).
    - Verify: an e2e covers name-box navigation to `Summary!B7` and to a defined name, Escape discarding the draft, and Shift+Enter inserting a newline in a `=PY(` draft.
    - _Requirements: 2.1–2.4_
  - [ ] 3.2 Implement `CellInspector` (dialect and engine badge, error details with an origin link, a 100-row `TableRef` preview, a `Matrix2D` table, precedents and dependents, assertions).
    - Verify: inspecting `Data!A1` in flagship 2 decodes only 100 rows (instrumented row counter); clicking an error origin selects it.
    - _Requirements: 3.1–3.5_

- [ ] 4. Readiness pill
  - [ ] 4.1 Implement `engineLabel` and `ReadinessPill` with the popover and Retry.
    - Verify: a unit test maps every `EngineState` per design §4; an e2e on a fresh page shows `Grid Ready | DuckDB Lazy | Python/NumPy Lazy`, then `Loading` and `Ready` after the first `=SQL()`; an unisolated page shows `Degraded (single-threaded)` with the full reason in the accessible name; a known-length download shows a percentage and an unknown-length one does not.
    - _Requirements: 4.1–4.6_

- [ ] 5. X-Ray
  - [ ] 5.1 Implement `xray/geometry.ts` (`threadCurve`, `splitAt`, `brokenThread`).
    - Verify: property tests show `splitAt` halves reproduce the original curve points (within 1e-9 px), the gap arc length is 6 ± 0.1 px, and control offsets are clamped to [40, 240].
    - _Requirements: 5.1, 5.5_
  - [ ] 5.2 Implement `computeXRayFrame` with the 1,500 cap, the hidden count, fractured and broken flags, and memoization.
    - Verify: a 10,000-edge workbook yields ≤ 1,500 threads and the correct `hidden`; scrolling inside the window does not recompute (spy count unchanged).
    - _Requirements: 5.3, 5.4, 5.8_
  - [ ] 5.3 Implement `XRayOverlay` (engine colors and dashes, pulse, reduced motion, accessible clickable fracture).
    - Verify: an e2e checks stroke and dash attributes per engine; with `reducedMotion: 'reduce'`, the computed `animation-name` is `none`; clicking or pressing Enter on a fractured path opens the counterexample.
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 5.7_

- [ ] 6. Bring your own data
  - [ ] 6.1 Implement `importKind`, size limits, `sanitizeDatasetName`, `isSutureDocument`, and routing.
    - Verify: unit tests cover each rejection path in Req 6.4 and the `.suture.json` detection.
    - _Requirements: 6.3, 6.4_
  - [ ] 6.2 Implement CSV, Parquet, and XLSX import with the import report and progress.
    - Verify: an e2e drops a 50 MB CSV and queries it with `=SQL()`; dropping the Spec 02 task 10.1 fixture `.xlsx` gives the expected sheets, datasets, error counts, and warnings; no long task over 50 ms.
    - _Requirements: 6.1, 6.2, 6.6_
  - [ ] 6.3 Implement `gatedPyEngine` and `TrustDialog`.
    - Verify: opening a non-built-in document with `=PY()` makes no Pyodide network request and shows the exact blocked message; trusting recalculates and evaluates the cells.
    - _Requirements: 6.5_

- [ ] 7. Exorcist panel and replay
  - [ ] 7.1 Implement `ExorcistPanel` (start/stop, mode, seed, progress, verdict card, copy link, download JSON, show in X-Ray) and stale marking.
    - Verify: an e2e on flagship 1 shows a violated verdict with all fields; editing during a session marks it stale; the downloaded file parses with `isReplayArtifact`.
    - _Requirements: 7.1, 7.2, 7.5_
  - [ ] 7.2 Implement `#replay=v1.` handling: built-in lookup by hash, a prompt for other documents, and the replay outcome display with X-Ray highlight.
    - Verify: opening a copied link in a fresh context reproduces the violation as `exact`; a link for an unknown hash prompts for a document; a corrupted link shows the decode error.
    - _Requirements: 7.3, 7.4_

- [ ] 8. Flagship workbooks
  - [ ] 8.1 Author `saas-runway.suture.json` per design §7.1, and generate `flagshipHashes.ts` at build time.
    - Verify: a unit test checks every base value in the §7.1 table bit for bit, that all assertions hold at the base case, and that the session mode is `inProcess`.
    - _Requirements: 8.1–8.4_
  - [ ] 8.2 Author `ecommerce-margin.suture.json` per design §7.2.
    - Verify: an e2e shows `Data!A1` has 100,000 rows and its IPC SHA-256 is identical across two page loads; all base-case assertions hold; the session mode is `batched`.
    - _Requirements: 9.1–9.6_

- [ ] 9. Genuine discovery tests
  - [ ] 9.1 Add the estimation and control tests (design §8) for both flagships.
    - Verify: the failing fraction is ≥ 1% with the shipped formulas, and there are zero violations of the expected assertion with the corrected formulas, for each flagship.
    - _Requirements: 10.3, 10.4_
  - [ ] 9.2 Add `flagships.spec.ts`, which runs with a fresh random seed, logs it, and checks the expected assertion id and exact replay.
    - Verify: the test passes on 20 consecutive CI runs; a review checklist item confirms the file contains no input values or seeds.
    - _Requirements: 10.1, 10.2_

- [ ] 10. Trademark check
  - [ ] 10.1 Add the digest-based trademark scan (design §9).
    - Verify: the scanner, run with an in-memory digest list that adds the digest of a made-up word, fails on a temporary file containing that word (the file is created and deleted inside the test); the real digest list passes on the clean repository. No banned term is ever written by the test.
    - _Requirements: 11.2_
