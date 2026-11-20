---
inclusion: fileMatch
fileMatchPattern: "packages/web/**"
---

# UI Craft & Branding

## 1. Aesthetic

Suture looks like a quantitative terminal: dense, precise, quiet. The Kiroween motif stays functional and understated. The "haunting" is the Exorcist finding real bugs, not decoration. No mascots, ghosts, or novelty fonts.

### Design tokens (Tailwind theme extension)

| Token | Value | Use |
|---|---|---|
| `obsidian` | `#0B0E13` | App background |
| `slate-surface` | `#121821` | Grid, panels |
| `slate-raised` | `#1A2230` | Headers, popovers |
| `slate-line` | `#263142` | Gridlines, borders |
| `ink` | `#D6DEEA` | Primary text |
| `ink-muted` | `#7C8AA0` | Secondary text |
| `engine-sql` | `#22D3EE` (cyan) | SQL cells and threads |
| `engine-py` | `#F59E0B` (amber) | Python cells and threads |
| `engine-formula` | `#10B981` (emerald) | Formula cells and threads |
| `fracture` | `#DC143C` (crimson) | Failing lineage, counterexamples |

- Numbers use a tabular monospace font (`font-variant-numeric: tabular-nums`) and are right-aligned.
- Body text meets WCAG AA contrast against its surface.
- Engine colors come only from these tokens. Never hard-code hex values in components.

## 2. X-Ray Mode

- X-Ray Mode draws dependency threads between cells as cubic bezier curves on a single overlay layer above the grid.
- Each thread takes the color of the **dependent** cell's engine: SQL cyan, Python amber, Formula emerald.
- Color is never the only signal. Each engine also has a distinct dash pattern (SQL dashed, Python dotted, Formula solid), so the view works for color-blind users.
- Threads are drawn only for cells in or adjacent to the visible viewport. Path geometry is recomputed only when layout or the graph changes, not on every frame.
- **Fracture:** when the Exorcist finds a counterexample, the exact failing lineage (from the input cells the shrunk counterexample touches to the cell whose property failed) switches to `fracture` crimson, renders as a broken thread at the failing edge, and pulses.
- The pulse animates only `opacity` or `stroke-dashoffset`. Under `prefers-reduced-motion: reduce` it becomes a static crimson highlight.
- Clicking a fractured thread opens the counterexample: property name, shrunk inputs, and the observed versus expected value.

## 3. Performance: zero main-thread jank

- The grid is virtualized: only visible rows and columns plus a small overscan are mounted.
- DuckDB and Pyodide never run on the main thread, and pure-formula evaluation there is bounded to the visible recalculation set (see `architecture-and-isolation.md`, Worker isolation). A main-thread task longer than 50 ms during scrolling, typing, or X-Ray rendering is a defect.
- Scrolling and selection must not trigger React re-renders of off-screen cells or synchronous layout reads inside render loops.

## 4. Honest engine readiness

Engines load progressively. The grid is never blocked waiting for them.

1. **Grid** is interactive immediately. Formula cells evaluate as soon as the page loads.
2. **DuckDB** loads lazily on the first `=SQL()` cell (or when the browser is idle).
3. **Pyodide + NumPy** loads lazily on the first `=PY()` cell (or when the browser is idle, after DuckDB).

- The indicator shows one of these states per engine: `not loaded`, `loading`, `ready`, `degraded`, `failed`.
- Show real progress only when the loader reports bytes. Otherwise show an indeterminate state. Never show a fake percentage.
- `degraded` states the reason in plain words, for example "DuckDB: single-threaded (page is not cross-origin isolated)".
- Cells waiting for an engine show a pending state, not an error and not a stale value.

## 5. Trademark hygiene

- Never use third-party spreadsheet product names or trademarks in UI copy, docs, comments, identifiers, or commit messages.
- Say "spreadsheet-compatible formulas" or "legacy spreadsheets" instead.
- Generic file-format names such as `.xlsx` / `.csv` and their standards (ECMA-376) are allowed when describing import and export.
