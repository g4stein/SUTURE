/**
 * `@suture/runtime/node`: the Node.js host (Node APIs allowed). Boots the real DuckDB-WASM and Pyodide engines in-process
 * behind the shared handlers, and provides the Node hasher, compressor, and clock. Used by the runtime tests,
 * `packages/cli`, and `packages/mcp`.
 */
export * from './engines.ts';
export * from './adapters.ts';
export * from './files.ts';
