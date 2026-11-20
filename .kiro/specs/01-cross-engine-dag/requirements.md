# Requirements: Cross-Engine DAG

## Introduction

This spec defines the `packages/core` dependency graph that unifies three cell dialects (spreadsheet-compatible formulas, DuckDB SQL via `=SQL()`, and Pyodide NumPy via `=PY()`) under one address space, one value contract, one scheduler, and one determinism guarantee. It implements `.kiro/steering/dag-and-type-contract.md` and obeys `.kiro/steering/architecture-and-isolation.md`. Where this spec and the steering differ, the steering wins and this spec is defective.

Glossary:
- **Workbook**: sheets, cell sources, named parameters, dataset metadata, and a workbook seed.
- **Cell source**: the raw text a user typed into a cell.
- **Dialect**: `literal`, `formula`, `sql`, or `py`, determined from the cell source.
- **Engine cell**: a cell whose dialect is `sql` or `py`.
- **Generation**: one recalculation pass, identified by a monotonically increasing integer.
- **Supported subset**: the 30 functions listed in Requirement 6.

## Requirements

### Requirement 1: Unified cell addressing

**User Story:** As a modeler, I want one reference syntax across formulas, SQL, and Python, so that any cell can depend on any other cell regardless of dialect.

#### Acceptance Criteria
1. THE SYSTEM SHALL represent every cell by a canonical `CellKey` of the form `<sheet>!<column letters><row number>`, with uppercase column letters, no `$` markers, and sheet names quoted with single quotes (embedded quotes doubled) only when they do not match `^[A-Za-z_][A-Za-z0-9_]{0,30}$`.
2. THE SYSTEM SHALL accept cell references `A1`, `$A$1`, `A$1`, `$A1`, `Sheet!A1`, and `'Sheet name'!A1`, and range references `A1:C10` and `Sheet!A1:C10`, in formula, SQL interpolation, and Python input syntax alike.
3. WHEN a reference omits the sheet, THE SYSTEM SHALL resolve it against the sheet of the cell that contains the reference.
4. THE SYSTEM SHALL limit addresses to rows 1–1,048,576 and columns A–XFD (1–16,384).
5. IF a reference names a sheet that does not exist or an address outside the grid limits, THEN THE SYSTEM SHALL evaluate the referencing cell to `#REF!`.
6. WHEN a range is written with its corners in any order (for example `C10:A1`), THE SYSTEM SHALL normalize it to top-left:bottom-right.
7. THE SYSTEM SHALL support workbook-level named parameters that map a case-insensitive name matching `^[A-Za-z_][A-Za-z0-9_.]{0,254}$` to a cell or range, and SHALL reject names that parse as a cell reference, `TRUE`, `FALSE`, or a function name in the supported subset.
8. IF a formula, SQL template, or Python input key uses a name that is not defined, THEN THE SYSTEM SHALL evaluate the referencing cell to `#NAME?`.

### Requirement 2: Dialect detection

**User Story:** As a modeler, I want Suture to recognize what kind of cell I typed, so that each cell runs on the right engine.

#### Acceptance Criteria
1. WHEN a cell source starts with `=SQL(` (case-insensitive, after leading whitespace), THE SYSTEM SHALL classify the cell as dialect `sql` and engine `sql`.
2. WHEN a cell source starts with `=PY(` (case-insensitive, after leading whitespace), THE SYSTEM SHALL classify the cell as dialect `py` and engine `py`.
3. WHEN a cell source starts with `=` and is not dialect `sql` or `py`, THE SYSTEM SHALL classify the cell as dialect `formula` and engine `formula`.
4. WHEN a cell source does not start with `=`, THE SYSTEM SHALL classify the cell as dialect `literal` and engine `formula`, parsing it as a finite number, `TRUE`/`FALSE` (case-insensitive), an error literal, the empty value `null` (empty source), or otherwise a string.
5. WHEN a literal source equals one of the ten canonical error codes, `#NULL!`, or `#SPILL!`, THE SYSTEM SHALL store it as the corresponding canonical `CellError`, with `origin` set to the cell itself and `engine` `formula`.
6. IF `=SQL(` or `=PY(` is used anywhere other than as the entire top-level expression of a cell, THEN THE SYSTEM SHALL evaluate the cell to `#VALUE!` with a message stating that engine calls must be the whole cell.

### Requirement 3: `=SQL()` cells

**User Story:** As an analyst, I want to query datasets and other cells with SQL, so that I can work with large tables locally.

#### Acceptance Criteria
1. THE SYSTEM SHALL accept `=SQL("<template>")` with exactly one string-literal argument using formula string syntax (`""` escapes a quote).
2. WHEN a template contains `{{<cell reference>}}` or `{{<name>}}` resolving to a single cell holding a scalar value, THE SYSTEM SHALL replace it with a positional prepared-statement parameter (`$1`, `$2`, …) and bind the cell value, and SHALL NOT splice the value into the SQL text.
3. WHEN a template contains `{{<range reference>}}` or `{{<name>}}` resolving to a range, THE SYSTEM SHALL bind the range as a temporary table whose columns are named by the range's column letters (`A`, `B`, …), with every row treated as data.
4. WHEN a template interpolation resolves to a single cell holding a `TableRef`, THE SYSTEM SHALL bind that table as a temporary table.
5. THE SYSTEM SHALL substitute each table binding with a generated identifier `__suture_b<n>`, where `<n>` is the zero-based binding index in order of first appearance.
6. THE SYSTEM SHALL allow SQL to reference registered datasets by their registry names as bare identifiers.
7. IF any interpolated input is a `CellError`, THEN THE SYSTEM SHALL evaluate the cell to the first such error in order of appearance in the template, without dispatching the query.
8. IF a template contains an unterminated `{{` or an empty interpolation, THEN THE SYSTEM SHALL evaluate the cell to `#SQL!` without dispatching the query.
9. WHEN the engine returns a result, THE SYSTEM SHALL store a `TableRef`, or the collapsed scalar for a 1 row × 1 column result, as defined in the steering contract.

### Requirement 4: `=PY()` cells

**User Story:** As a quant, I want to run NumPy code against cell values and tables, so that I can do vectorized numeric work inside the workbook.

#### Acceptance Criteria
1. THE SYSTEM SHALL accept `=PY("<code>")` and `=PY("<code>", <vectorized>)`, where `<vectorized>` is the literal `TRUE` or `FALSE` (default `FALSE`).
2. THE SYSTEM SHALL derive the cell's dependencies from every occurrence of `inputs['<ref>']` or `inputs["<ref>"]` in the code, where `<ref>` is a cell reference, range reference, or named parameter.
3. WHEN the code runs, THE SYSTEM SHALL expose a dict `inputs` keyed by each `<ref>` string exactly as written, with values bound as follows: number to `float`, string to `str`, boolean to `bool`, `null` to `None`, `Matrix2D` to a 2-D `float64` `numpy.ndarray`, `TableRef` to a `dict` mapping column names to NumPy arrays (strings as `list[str | None]`), an all-numeric-or-empty range to a 2-D `numpy.ma.MaskedArray` with empty cells masked, and any other range to a row-major `list[list]` of Python scalars.
4. THE SYSTEM SHALL expose `np` (NumPy) and `rng`, a `numpy.random.Generator` seeded from the workbook seed and the cell's `CellKey` only.
5. THE SYSTEM SHALL use the value of the code's final expression statement as the cell result, and `None` when the code does not end in an expression.
6. IF any bound input is a `CellError`, THEN THE SYSTEM SHALL evaluate the cell to the first such error in order of first appearance in the code, without dispatching to the worker.
7. IF the code reads an `inputs` key that was not statically declared, THEN THE SYSTEM SHALL evaluate the cell to `#PY!`.

### Requirement 5: Formula language

**User Story:** As a modeler, I want spreadsheet-compatible formula syntax, so that existing models work without retraining.

#### Acceptance Criteria
1. THE SYSTEM SHALL parse number, string, and boolean literals, cell and range references, named parameters, function calls, parentheses, unary `+`/`-`, postfix `%`, and binary `^ * / + - & = <> < > <= >=`, with legacy spreadsheet precedence (range `:`, then unary minus, `%`, `^`, `* /`, `+ -`, `&`, comparisons).
2. THE SYSTEM SHALL evaluate `-2^2` to `4` (unary minus binds tighter than `^`), matching legacy spreadsheets.
3. IF a formula fails to parse, THEN THE SYSTEM SHALL evaluate the cell to `#VALUE!` with a message giving the zero-based character offset of the failure.
4. THE SYSTEM SHALL print any parsed formula AST back to source text such that parsing the printed text yields a structurally equal AST.
5. WHEN `/` has a divisor equal to `0` or `-0`, THE SYSTEM SHALL produce `#DIV/0!`.
6. WHEN `^` computes `0^0`, THE SYSTEM SHALL produce `#NUM!`, and WHEN `^` raises `0` to a negative exponent, THE SYSTEM SHALL produce `#DIV/0!`.
7. THE SYSTEM SHALL compare strings case-insensitively after Unicode lowercasing without locale, and SHALL order mixed types as number < string < boolean.

### Requirement 6: The 30-function supported subset

**User Story:** As a modeler, I want a precise, documented function set, so that I know exactly what will and will not evaluate.

#### Acceptance Criteria
1. THE SYSTEM SHALL support exactly these 30 functions: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `ROUND`, `ABS`, `POWER`, `SQRT`, `MOD`, `SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `AVERAGEIF`, `IF`, `AND`, `OR`, `NOT`, `IFERROR`, `ISERROR`, `ISBLANK`, `ISNUMBER`, `VLOOKUP`, `INDEX`, `MATCH`, `NPV`, `PMT`, `IRR`.
2. THE SYSTEM SHALL match function names case-insensitively.
3. IF a formula calls any function outside the supported subset (including `IFNA`, `ISERR`, `ISNA`, and `ERROR.TYPE`), THEN THE SYSTEM SHALL evaluate the cell to `#NAME?`, and SHALL never return `0`, `null`, `undefined`, or an unmapped library value for it.
4. THE SYSTEM SHALL evaluate each function per the signature, coercion, and edge-case table in `design.md` §6.
5. IF a function receives the wrong number of arguments, THEN THE SYSTEM SHALL evaluate the cell to `#VALUE!`.

### Requirement 7: Error propagation

**User Story:** As a modeler, I want errors to travel predictably, so that the source of a failure is never hidden.

#### Acceptance Criteria
1. WHEN a formula outside `IFERROR` and `ISERROR` receives a `CellError` in any argument, directly or inside a range, THE SYSTEM SHALL evaluate to the first error in argument evaluation order (arguments left to right, ranges row-major), with `code`, `origin`, and `engine` preserved.
2. THE SYSTEM SHALL evaluate all arguments of every function eagerly, including both branches of `IF`, so that an error in any argument propagates.
3. WHEN `IFERROR(value, fallback)` receives a `CellError` as `value`, THE SYSTEM SHALL return `fallback`, and otherwise SHALL return `value`.
4. WHEN `ISERROR(value)` is evaluated, THE SYSTEM SHALL return `true` if `value` is a `CellError` and `false` otherwise.
5. WHEN a cell's value becomes a `CellError`, THE SYSTEM SHALL recalculate every dependent and propagate the error to it.

### Requirement 8: Numeric normalization

**User Story:** As a modeler, I want NaN and Infinity never to leak into cells, so that silent corruption is impossible.

#### Acceptance Criteria
1. THE SYSTEM SHALL apply the steering numeric policy (NaN → `#NUM!`; detected division by zero → `#DIV/0!`; other ±Infinity → `#NUM!`; unsafe integers → `#NUM!` on scalar conversion) at every engine boundary before a value enters the DAG.
2. THE SYSTEM SHALL run `assertCanonical` on every value at the engine boundary, and IF it fails, THEN THE SYSTEM SHALL throw an invariant violation error that tests report as a failure.
3. THE SYSTEM SHALL map library error strings per the steering mapping table (`#NULL!` → `#VALUE!`, `#SPILL!` → `#REF!`, unknown → `#VALUE!` with the raw string in `message`).

### Requirement 9: Cycle detection

**User Story:** As a modeler, I want circular references reported with the exact loop, so that I can break them quickly.

#### Acceptance Criteria
1. WHEN the dependency graph contains a strongly connected component of two or more cells, or a cell that references itself (directly or through a range containing itself), THE SYSTEM SHALL evaluate every cell in that component to `#CYCLE!` with `origin` set to the cell itself.
2. THE SYSTEM SHALL set each cycle cell's error `message` to `cycle: ` followed by the shortest cycle through that cell, written as `A1 -> B2 -> C1 -> A1` (cell keys printed without a sheet prefix when all cells share one sheet, otherwise with full keys), with ties broken by row-major successor order.
3. THE SYSTEM SHALL report every cycle in `RecalcResult.cycles`, with members sorted row-major and one path per member.
4. WHEN an edit removes the last edge of a cycle, THE SYSTEM SHALL recompute every former member and dependent, so that no stale `#CYCLE!` remains.
5. THE SYSTEM SHALL propagate `#CYCLE!` to cells downstream of a cycle through normal error propagation.

### Requirement 10: Scheduling

**User Story:** As a modeler, I want fast, correct recalculation, so that only what changed is recomputed and slow engines never stall the grid.

#### Acceptance Criteria
1. WHEN an edit is applied, THE SYSTEM SHALL start a new generation whose dirty set is the edited cells plus all their transitive dependents.
2. THE SYSTEM SHALL evaluate the dirty set in topological order using Kahn's algorithm, breaking ties among ready cells by row-major order (sheet order, then row, then column) by default.
3. WHEN an engine cell becomes ready, THE SYSTEM SHALL dispatch it asynchronously and continue evaluating other ready cells.
4. WHEN a new generation starts while engine requests from an earlier generation are in flight, THE SYSTEM SHALL cancel the in-flight requests whose cells are in the new dirty set, and SHALL re-tag the others to the new generation without re-dispatching them.
5. IF an engine result arrives for a cell whose request was cancelled or superseded, THEN THE SYSTEM SHALL discard it without committing.
6. WHILE an engine cell awaits its result, THE SYSTEM SHALL report it as pending and SHALL NOT expose a stale value for it as current.
7. WHERE a host sets a time slice (`sliceMs > 0`), THE SYSTEM SHALL yield to the host through the injected `yieldControl` after at most `sliceMs` of synchronous evaluation, without changing evaluation order.

### Requirement 11: Determinism

**User Story:** As an auditor, I want identical inputs to give identical outputs, so that every finding can be reproduced.

#### Acceptance Criteria
1. THE SYSTEM SHALL produce bit-identical values for every cell for a given workbook state, regardless of which valid topological order is used.
2. THE SYSTEM SHALL produce bit-identical values for a given final workbook state regardless of the sequence of edits that led to it, including full versus incremental recalculation.
3. THE SYSTEM SHALL take all randomness from the workbook seed and all time from an injected clock, and SHALL NOT read `Math.random`, `Date.now`, or `performance.now` in `packages/core`.
4. THE SYSTEM SHALL support a seeded tie-break mode (`TieBreak` `seeded`) that permutes ready-queue order deterministically from a seed, for use by determinism tests and the Exorcist.
5. THE SYSTEM SHALL compute integer powers (in `^`, `POWER`, `NPV`, `PMT`, and `IRR`) by binary exponentiation, so that results are bit-identical across JavaScript engines.
6. WHERE an exponent is not an integer, THE SYSTEM SHALL use `Math.pow`, and the bit-identical guarantee SHALL apply within one JavaScript engine family.

### Requirement 12: Scenario evaluation for fuzzing

**User Story:** As the Exorcist, I want to evaluate many input scenarios without mutating the workbook, so that I can fuzz efficiently.

#### Acceptance Criteria
1. THE SYSTEM SHALL evaluate a batch of scenarios, each a set of literal overrides, over the subgraph between the overridden cells and a target cell set, without mutating workbook state.
2. WHEN a scenario batch contains engine cells, THE SYSTEM SHALL issue at most one batched engine request per engine cell per batch, independent of the number of scenarios, and SHALL omit scenarios that short-circuit on an upstream error.
3. THE SYSTEM SHALL produce, for each scenario, values bit-identical to applying the overrides as `setLiteral` edits and recalculating, except where a vectorized `=PY()` cell uses `rng`.
4. IF an override targets a cell that is not a literal cell, THEN THE SYSTEM SHALL reject the batch with a configuration error before evaluation.

### Requirement 13: Purity

**User Story:** As a maintainer, I want `packages/core` to run unchanged in every host, so that Web, CLI, and MCP behave identically.

#### Acceptance Criteria
1. THE SYSTEM SHALL compile `packages/core` with `"lib": ["ES2022"]` and `"types": []`, with no DOM or Node APIs.
2. THE SYSTEM SHALL reach SQL and Python only through the `SqlEngine` and `PyEngine` port interfaces, and cancellation only through the `CancellationToken` interface.
3. THE SYSTEM SHALL contain no `any` types.
