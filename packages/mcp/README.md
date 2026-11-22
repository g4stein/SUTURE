# @g4stein/suture-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for [Suture](https://github.com/g4stein/SUTURE), a zero-backend spreadsheet engine whose cells run in three engines: spreadsheet formulas, DuckDB SQL (`=SQL()`), and Python with NumPy (`=PY()`).

The server lets an agent such as Kiro audit a model with property-based testing. It finds the inputs that break a model's assertions, shrinks them to a minimal counterexample, and checks a formula fix in memory before anyone edits a file. All computation runs on your machine, with real DuckDB-WASM and Pyodide engines. No workbook data is sent anywhere.

## Requirements

- Node.js 22 or later.
- Network access on the first run only: Pyodide downloads NumPy from its CDN, and DuckDB downloads its JSON extension. Without network access, SQL validation falls back to a stricter lexical check.

## Use it in Kiro

Add the server to `.kiro/settings/mcp.json` in your workspace, or to `~/.kiro/settings/mcp.json` for every workspace:

```json
{
  "mcpServers": {
    "suture": {
      "command": "npx",
      "args": ["-y", "@g4stein/suture-mcp@0.1.0"],
      "autoApprove": ["suture_list_workbooks", "suture_inspect_lineage"]
    }
  }
}
```

The server treats the directory it starts in as the workspace root. Pass `--root <dir>`, or set `SUTURE_WORKSPACE`, to choose another one. Workbook paths must stay inside the root.

Any MCP client that launches stdio servers works the same way. Run `npx -y @g4stein/suture-mcp@0.1.0` and speak JSON-RPC on stdin and stdout. The server answers both the 2025-11-25 `initialize` handshake and the stateless 2026-07-28 revision (`server/discover`).

## Tools

| Tool | What it does | Runs workbook code |
|---|---|---|
| `suture_list_workbooks` | Lists the built-in `flagship:1` and `flagship:2` workbooks and every `.suture.json` file under the workspace root, with sheets, fuzz inputs, assertions, and Python status. | no |
| `suture_inspect_lineage` | Returns a cell's dialect, formula, upstream precedents, downstream dependents, and full topological chain. | no |
| `suture_run_audit` | Runs the Exorcist. Returns the Tier 1 and Tier 2 verdicts, the shrunk `failingInputs`, the failing `lineagePath`, and a replay artifact. Deterministic for a given `seed`. | yes |
| `suture_verify_patch` | Applies one or more cell patches to an in-memory copy of the workbook. It replays the original counterexample, runs a fresh audit with the same seed, and compares base cases. Returns `{ ok, seed, counterexampleFixed, freshAuditPassed, regressions, baseValueDiffs }`. Never writes to disk. | yes |

For example, on the built-in SaaS runway model:
1. `suture_run_audit` with `{ "workbook": "flagship:1" }` reports that `runway-non-negative` is violated. Runway goes negative once the projected burn turns negative.
2. `suture_verify_patch` with `{ "workbook": "flagship:1", "patches": { "Model!B5": "=IF(B4<=0,120,Inputs!B2/B4)" }, "replayArtifact": <artifact from step 1> }` returns `ok: true`, with zero regressions.

## Python trust

Under Node, Python running in Pyodide can reach the file system and the network through Pyodide's JavaScript bridge. The server therefore runs `=PY()` cells only for the built-in flagships. A `.suture.json` file's Python cells evaluate to `#PY!` ("Python is blocked until you trust this workbook") unless the tool call passes `trustPython: true`. Trust a workbook only as far as you would trust a script, and don't auto-approve the two tools that run workbook code.

The engines run in the server process. A cell whose code never returns blocks the server until you restart it.

## License

MIT. `dist/suture-mcp.mjs` bundles third-party open-source code; its license and notice texts are in `dist/THIRD_PARTY_LICENSES.md`.
