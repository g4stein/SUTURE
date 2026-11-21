// Vite and Vitest inline `?raw` imports as strings; the CLI and MCP bundles carry the Python bridge source this way.
declare module '*.py?raw' {
  const source: string;
  export default source;
}
