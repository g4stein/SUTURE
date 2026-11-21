/**
 * `@suture/runtime/headless`: what the CLI and the MCP server do, written once (Spec 05 §3). Every function takes a
 * `HeadlessHost` (the real engines behind the core ports) and returns a JSON-ready report; none touches Node APIs, so
 * `packages/cli` and `packages/mcp` differ only in how they read input and print output.
 */
export * from './json.ts';
export * from './format.ts';
export * from './workbook.ts';
export * from './evaluate.ts';
export * from './inspect.ts';
export * from './audit.ts';
export * from './verifyPatch.ts';
export * from './flagships.ts';
