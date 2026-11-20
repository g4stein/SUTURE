---
inclusion: always
---

# DAG & Type Contract

This document is the canonical contract for values, errors, coercion, and propagation across the formula engine, DuckDB (`=SQL()`), and Pyodide NumPy (`=PY()`). `packages/core` implements it. Engine adapters must produce values that already satisfy it.

## 1. `CellValue`

```ts
export type EngineId = 'formula' | 'sql' | 'py';

export type CellErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#N/A'
  | '#CYCLE!'
  | '#NUM!'
  | '#SQL!'
  | '#PY!'
  | '#TIMEOUT!';

export interface CellError {
  readonly kind: 'error';
  readonly code: CellErrorCode;
  /** Human-readable cause. Never shown as the cell's value, only in inspectors. */
  readonly message: string;
  /** Address of the cell where the error originated (not where it propagated to). */
  readonly origin: string;
  readonly engine: EngineId;
}

export interface ArrowField {
  readonly name: string;
  /** Arrow type as reported by apache-arrow, e.g. "Float64", "Int64", "Utf8", "Bool". */
  readonly arrowType: string;
  readonly nullable: boolean;
}

export interface TableRef {
  readonly kind: 'table';
  /** Arrow IPC stream bytes. This Uint8Array owns its whole ArrayBuffer. */
  readonly ipc: Uint8Array;
  readonly schema: ReadonlyArray<ArrowField>;
  readonly rowCount: number;
}

export interface Matrix2D {
  readonly kind: 'matrix';
  readonly rows: number;
  readonly cols: number;
  /** Row-major, length === rows * cols, every element finite. */
  readonly data: Float64Array;
}

export type CellValue =
  | number   // always finite
  | string
  | boolean
  | null     // empty cell or SQL/Python null
  | TableRef
  | Matrix2D
  | CellError;
```

### Invariants
- A `number` `CellValue` is always finite. `NaN`, `Infinity`, and `-Infinity` never appear as cell values.
- Every element of `Matrix2D.data` is finite. Every value in a floating-point column of a `TableRef` is finite or Arrow-null.
- Object variants are discriminated by `kind`. No other object shapes are valid `CellValue`s.
- `core` exposes `assertCanonical(value: CellValue): void`. It runs at every engine boundary and is a standing `fast-check` property. A violation is a fatal invariant bug, never a recoverable runtime state.

## 2. Canonical error codes

| Code | Meaning |
|---|---|
| `#DIV/0!` | Detected division by zero |
| `#VALUE!` | Wrong operand type or a coercion that cannot succeed |
| `#REF!` | Reference to a cell or range that does not exist |
| `#NAME?` | Unknown function or name, including functions outside the supported subset |
| `#N/A` | Value not available (lookup miss) |
| `#CYCLE!` | Cell participates in, or depends on, a circular reference |
| `#NUM!` | Non-finite or out-of-range numeric result |
| `#SQL!` | DuckDB parse, bind, or execution error, or a SQL worker protocol error |
| `#PY!` | Python exception (other than division by zero), unsupported return type, or a Python worker protocol error |
| `#TIMEOUT!` | Evaluation exceeded its deadline |

### Library error mapping (engine boundary)
`@formulajs/formulajs` and `fast-formula-parser` return legacy spreadsheet error strings. The boundary maps them as follows:

| Library value | Canonical |
|---|---|
| `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#N/A`, `#NUM!` | unchanged |
| `#NULL!` | `#VALUE!` |
| `#SPILL!` | `#REF!` |
| any other error string | `#VALUE!`, with the raw library string kept in `message` |

## 3. Numeric policy: NaN and Infinity

IEEE-754 `NaN` or `±Infinity` produced in JavaScript, SQL, or NumPy is normalized at the engine boundary, before the value enters the DAG. Letting `NaN` silently cross a cell boundary is a fatal invariant violation.

1. `NaN` always becomes `#NUM!`.
2. `±Infinity` becomes `#DIV/0!` only when an explicit division by zero was detected:
   - the formula engine's `/` operator (and the division-based functions in the supported subset) with a zero divisor;
   - in Python, a `ZeroDivisionError`, or a NumPy divide-by-zero floating-point event captured with `numpy.errstate(divide='call')` and `numpy.seterrcall`.
3. Every other `±Infinity` becomes `#NUM!`. This includes overflow, and any non-finite float returned by DuckDB, because SQL results do not report which operation produced them.
4. If any element of a `Matrix2D`, or any value in a floating-point column of a `TableRef`, is non-finite, the whole cell becomes the error chosen by rules 1–3. Errors are never stored per element.
5. Integers that cannot be represented exactly as a JS `number` (Arrow `Int64` / `UInt64` values or Python `int`s with magnitude above `Number.MAX_SAFE_INTEGER`) become `#NUM!` when converted to a scalar or `Matrix2D`. Inside a `TableRef` they stay as Arrow integers.

### SQL `NULL` (intentional exception)
- DuckDB returns `NULL` for many divisions by zero (for example integer and decimal division). Depending on operand type and DuckDB settings, floating-point division may instead return IEEE `Infinity` or `NaN`, which rules 1–3 handle.
- SQL `NULL` maps to `null`, never to an error. This is intentional. SQL semantics stay intact, and silent `NULL` cascades are audited explicitly by the Exorcist's `notNull` and `finite` assertions instead of being converted to errors behind the user's back.

## 4. Cross-engine coercion

### Formula engine
- Arithmetic: `true -> 1`, `false -> 0`, `null -> 0`. A numeric string (for example `"3"` or `"-1.5e2"`) parses to a number. Any other string gives `#VALUE!`.
- Concatenation: `null -> ""`, booleans render as `TRUE` / `FALSE`, numbers use the shortest round-trip decimal representation.
- `TableRef` or `Matrix2D` used where a scalar is required gives `#VALUE!`.

### `=SQL()` results
- The result is a `TableRef`.
- A result of exactly 1 row × 1 column collapses to its scalar: numeric to `number` (after section 3 rules), `VARCHAR` to `string`, `BOOLEAN` to `boolean`, `NULL` to `null`. Other types give `#VALUE!` when collapsed.
- Scalar cell values interpolated into SQL are bound as prepared-statement parameters, never spliced into the SQL text.

### `=PY()` results
- `float` / `int` to `number` (after section 3 rules), `bool` to `boolean`, `str` to `string`, `None` to `null`.
- A 2-D NumPy numeric array becomes `Matrix2D`. A 1-D array becomes an `n × 1` `Matrix2D`. A 0-d array becomes its scalar.
- Any other return type gives `#PY!` with the Python type name in `message`.
- Python proxies are converted, then destroyed, before the result leaves the worker. No `PyProxy` crosses the worker boundary.

## 5. Error propagation

- A formula that evaluates a reference to a `CellError`, directly or through a range, evaluates to that upstream `CellError`. `code`, `origin`, and `engine` are preserved unchanged.
- Every function evaluates its arguments eagerly, left to right, **except `IF`**, which short-circuits:
  - `cond` is evaluated first, and a `CellError` in `cond` propagates immediately;
  - then only the taken branch is evaluated, and any `CellError` it produces propagates;
  - the untaken branch is never evaluated, so its errors cannot propagate. This keeps the universal division guard `=IF(B4=0, 0, A4/B4)` working.
  - `IF` is not an error-catching function.
- **Only `IFERROR` and `ISERROR` may intercept errors.**
  - `IFERROR(value, fallback)` returns `fallback` when `value` is a `CellError`, otherwise `value`.
  - `ISERROR(value)` returns `true` for any `CellError`, otherwise `false`.
- `IFNA`, `ISERR`, `ISNA`, and `ERROR.TYPE` are outside the supported function subset and resolve to `#NAME?`, like every other function missing from the allowlist.
- **Deterministic choice:** if several evaluated inputs are errors, the propagated error is the first one in argument evaluation order (arguments left to right; ranges row-major, top-left first; for `IF`, `cond` and then the taken branch).
- `=SQL()` and `=PY()` cells whose inputs contain a `CellError` do not execute. They take the upstream error immediately.
- An error is a value: dependents of an error cell are recalculated and receive the propagated error. They are never skipped or left stale.

## 6. Scheduling & cycles

- The dependency graph is a DAG over cell addresses. Edges come from parsed references in formulas and from the cell references used by `=SQL()` / `=PY()` parameters.
- Cycles are found with strongly connected components (Tarjan). Every cell in a non-trivial SCC, and every self-referencing cell, gets `#CYCLE!` with itself as `origin`. Cells downstream of a cycle receive `#CYCLE!` through normal propagation.
- Recalculation runs over the dirty subgraph in topological order (Kahn). Ties are broken by row-major cell address, so the order is reproducible.
- Each recalculation gets a monotonically increasing generation id. Asynchronous engine results are committed only if their generation is still current. Results from superseded generations are discarded.
- For the same workbook state and the same injected clock and seed, recalculation produces bit-identical `CellValue`s in Web, CLI, and MCP hosts.

## 7. Timeouts

- Each `=SQL()` and `=PY()` evaluation has a deadline. Exceeding it yields `#TIMEOUT!` on that cell only.
- **When `crossOriginIsolated` and `SharedArrayBuffer` are available:** cancel cooperatively (Pyodide interrupt buffer; DuckDB shared cancel flag checked between result chunks), and the worker survives. If the cancel does not settle within 1,000 ms, terminate and respawn the worker as below; only that request's cells become `#TIMEOUT!`.
- **When they are unavailable** (for example in Safari): terminate the worker and respawn it. Only cells whose evaluation was in flight on that worker become `#TIMEOUT!`. Queued requests are re-dispatched to the new worker, and any engine state they need (for example registered DuckDB tables) is restored before they run.
