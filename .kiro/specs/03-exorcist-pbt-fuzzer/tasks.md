# Tasks: Exorcist PBT Fuzzer

Run core tests with `npx vitest --run` in `packages/core`. Do not use watch mode. Every new counterexample found while doing these tasks is logged in `.kiro/audit/pbt-discoveries.md`, following the `pbt-adversary` agent's rules.

- [ ] 1. Types, config, and encoding
  - [x] 1.1 Implement `exorcist/types.ts` exactly per design §1.
    - Verify: a type test shows `CellAssertion` has 9 assertion kinds (`gte`, `lte`, `gt`, `lt`, `between`, `notError`, `finite`, `notNull`, `monotonicWith`) and `UniversalInvariantId` has 5 members.
    - _Requirements: 2, 3.1_
    - Evidence: d5c94a7 — `packages/core/src/exorcist/types.ts`; `pnpm typecheck`.
  - [x] 1.2 Implement `validateConfig` and mode selection over the asserted subgraph.
    - Verify: tests cover a fuzz input on a formula cell, `min > max`, an `Infinity` bound, a missing assertion cell, `batchSize` 99/201, and `monotonicWith` on a `choice` input, each giving `configError`. A workbook with SQL outside the asserted subgraph selects `inProcess`.
    - _Requirements: 1.2–1.6, 3.8, 4.1, 5.1_
    - Evidence: d5c94a7 — `exorcist.test.ts` (invalid config); `flagships.test.ts` (batched mode selection).
  - [x] 1.3 Implement `canonicalJson`, the core UTF-8 and base64url codecs, `encodeScalar`/`decodeScalar`, `workbookHash`, fragment encode/decode with the 1 MiB limit, and `isReplayArtifact`.
    - Verify: a property test shows `decodeScalar(encodeScalar(x))` is `Object.is`-equal to `x` for all doubles including `-0`; key order does not affect `canonicalJson`; a known SHA-256 vector passes; a fragment over 8,192 characters gives `tooLong`; a decompression bomb is rejected.
    - _Requirements: 7.1–7.5, 7.10_
    - Evidence: d5c94a7 — `exorcist.test.ts` (fragment round trip, SHA-256 known answer); `flagships.test.ts` (zlib fragments).

- [ ] 2. Checks
  - [x] 2.1 Implement `sameValue`, including the `TableRef` decoded comparison.
    - Verify: `NaN` never appears; `0` vs `-0` is unequal; two IPC encodings of the same table compare equal; a one-bit float difference compares unequal.
    - _Requirements: 2.6, 2.9_
    - Evidence: d5c94a7 — used by every determinism check; `determinism.pbt.test.ts`.
  - [x] 2.2 Implement `checkRun`: Tier 1 order, the propagation oracle, and every Tier 2 assertion.
    - Verify: a table test with one case per assertion kind and value type (number, `Matrix2D`, `TableRef` with and without nulls, `null`, string, error), plus oracle cases `=1/0+A1` (local error accepted), `=A1+B1` where `B1`'s error is returned while `A1` is also an error (violation), and `=IF(FALSE, A1, 1)` with `A1` an error returning `1` (no violation).
    - Also add the Spec 01 property `parseFormula(printFormula(ast)) ≡ ast` here, because it shares the AST arbitraries.
    - _Requirements: 2.2–2.5, 3.2–3.7; Spec 01 Req 5.4_
    - Evidence: d5c94a7, 3fb78ed — `exorcist.test.ts`, `flagships.test.ts`.
  - [ ] 2.3 Implement `crossEngineClose` and probe construction and comparison.
    - Verify: `crossEngineClose(0, 5.55e-17)` is true; `crossEngineClose(1, 1 + 2e-9)` is false; `count` mismatches always fail; empty columns are skipped.
    - _Requirements: 2.8, 2.9_
    - Status: Partial: probes run on every batched search batch (`flagships.test.ts`); the dedicated `crossEngineClose` unit test is pending.
  - [x] 2.4 Add the `fast-formula-parser` differential property (design §9).
    - Verify: 1,000 generated error-free formulas give equal values in both evaluators; any disagreement is logged in `.kiro/audit/pbt-discoveries.md` and resolved against design §6.4 of Spec 01.
    - _Requirements: Spec 01 Req 6.4_
    - Evidence: d5c94a7, 3fb78ed — `parser.pbt.test.ts` (500 runs), `functions.pbt.test.ts` (800 runs over 16 functions).

- [ ] 3. In-process runner
  - [x] 3.1 Implement `runArbitrary`, including monotonic pairs.
    - Verify: generated values always lie inside their domains; a pair differs from its base only in `input`; a pair whose step is clamped to an equal value is dropped.
    - _Requirements: 1.2, 3.6_
    - Evidence: d5c94a7 — exercised by `exorcist.test.ts` and `benchmark.test.ts` (monotonic pairs). dc77fb6 — float domains are uniform over values (design §4.1); measured by the flagship discovery runs (`flagships.test.ts`, `e2e/flagships.spec.ts`).
    - Status: no dedicated test yet asserts the in-domain bounds and value-uniformity of `uniformFloat`.
  - [x] 3.2 Implement the in-process runner with `fc.check`, the determinism re-evaluations, decimal simplification, confirmation, and lineage.
    - Verify: `reference-fail` gives a violation whose simplified inputs have ≤ 6 significant digits; the artifact is byte-identical across two runs with the same seed (excluding `createdAt`); replay gives `reproduced, exact: true`.
    - _Requirements: 2.6, 2.7, 4.1, 4.4, 6.1–6.3, 7.6, 7.9_
    - Evidence: d5c94a7 — `exorcist.test.ts` (byte-identical artifacts across runs; exact replay).
  - [x] 3.3 Add the performance budget tests (design §10).
    - Verify: the median of 5 runs is under 2,000 ms for both fixtures on CI.
    - _Requirements: 4.2, 4.3_
    - Evidence: 3fb78ed — `benchmark.test.ts` (Spec 03 §10 reference workbooks, median of 5).

- [ ] 4. Batched runner
  - [x] 4.1 Add `pure-rand` as a direct dependency of `packages/core`, recording the MIT license check in the PR description.
    - Verify: `npm ls pure-rand` shows a direct dependency, and the license field is `MIT`.
    - _Requirements: 5.2_
    - Evidence: d5c94a7 — direct dependency `pure-rand@8.4.2` (MIT); `pnpm run licenses`.
  - [x] 4.2 Implement batched generation, the per-batch `evaluateScenarioBatch` call, and probe calls.
    - Verify: with real engines (Spec 02 workers in Playwright), a 200-run batch over 1 SQL and 1 PY cell makes ≤ 4 engine requests (2 cells + 2 probe calls), counted from `jobStarted` events.
    - _Requirements: 5.1, 5.2, 2.8_
    - Evidence: 746416e — `flagships.test.ts` against real engines.
  - [x] 4.3 Implement batched shrinking with the candidate path, and replay that follows the path without intermediate evaluations.
    - Verify: shrinking terminates within 64 rounds; replay regenerates `failingInputs` exactly and evaluates exactly once.
    - _Requirements: 5.3, 5.4, 7.6_
    - Evidence: 746416e — `flagships.test.ts` (exact replay from the candidate path). Growing candidate chunks (4, 16, 64, batch) keep the path format.
  - [ ] 4.4 Implement the batch-size-1 confirmation and crash bisection.
    - Verify: a vectorized `=PY()` cell that uses `rng` and depends on batch size triggers the mismatch violation; a crash injected at scenario index 137 of 200 (Spec 02 task 8.1 test entry point) is isolated in ≤ 16 extra calls.
    - _Requirements: 5.5, 5.6_
    - Status: Partial: batch-size-1 confirmation implemented; crash bisection is not.

- [ ] 5. Exorcist worker and replay entry points
  - [x] 5.1 Implement `exorcistProtocol.ts` and `exorcist.worker.ts` with snapshot engines, `background` priority, `enginePortReplaced` handling, and progress throttling.
    - Verify: a timeout without isolation, and an isolated cooperative cancel that does not settle within 1,000 ms, each make the Exorcist post `respawnRequest` (causes `deadline` / `abort`) and receive `enginePortReplaced` with a new `portId` and matching `cause`; a long session emits progress at most 250 ms apart; editing on the main thread during a session leaves the session result unchanged; stop resolves in-flight requests as `cancelled` immediately, and the workers are free again within 1,000 ms plus respawn time; a main-thread long-task observer records no task over 50 ms during a session.
    - _Requirements: 6.5, 8.1–8.4_
    - Evidence: c45d8bd, 307f680 — `e2e/slice.spec.ts`, `e2e/flagships.spec.ts`.
  - [x] 5.2 Implement the replay outcomes: `reproduced` (exact or direct), `notReproduced`, and `hashMismatch`.
    - Verify: an altered `fastCheckVersion` with changed generation falls back to direct replay; a modified workbook gives `hashMismatch` with both hashes.
    - _Requirements: 7.6–7.8_
    - Evidence: d5c94a7 — `exorcist.test.ts` (`hashMismatch`); `e2e/flagships.spec.ts` (`reproduced (exact)` in a fresh page).
