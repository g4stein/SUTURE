/**
 * `@suture/runtime/engines`: the host-agnostic DuckDB-WASM, Pyodide, and XLSX ingest request handlers (Spec 02 §4–5, §10).
 * Every host runs exactly this code: the browser workers in `packages/web`, and the in-process Node host in
 * `@suture/runtime/node` (tests, `packages/cli`, `packages/mcp`). Hosts inject only the binding: which DuckDB-WASM build to
 * open, where Pyodide loads from, and how Pyodide reaches DuckDB's result cache.
 */
export * from './duckdbHandler.ts';
export * from './duckdbIpc.ts';
export * from './sqlValidate.ts';
export * from './pyodideHandler.ts';
export * from './arrowColumns.ts';
export * from './ingestHandler.ts';
