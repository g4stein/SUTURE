# PBT Discoveries

Real bugs caught by `fast-check` properties during the Suture build. One row per distinct counterexample. Rows are added by the `pbt-on-core-save` hook and the `pbt-adversary` agent. Only replayable counterexamples (with seed and path) are logged.

| Date | Commit | Property | Shrunk Counterexample | Root Cause & Fix |
|------|--------|----------|-----------------------|------------------|
| 2026-11-20 | d5c94a7 | `parse(print(ast)) ≡ ast` (packages/core/src/__tests__/parser.pbt.test.ts) | `AA(#N/A/FALSE)` — `{ seed: 20261120, path: "50:1:0:4:3:3" }`, shrunk 5 times from `call(AA, [binary('/', err #N/A, bool FALSE)])` | The lexer matched error literals with the greedy pattern `#[A-Za-z0-9/]+[!?]?`, so `#N/A/FALSE` became one unknown token and the printed formula failed to parse. Fix: match only the 12 known error literals, longest first (`#DIV/0!` … `#SPILL!`). Fixed in d5c94a7; the property now passes 2,000 runs. |