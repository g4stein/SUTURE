declare module 'fast-formula-parser' {
  interface Position {
    readonly row: number;
    readonly col: number;
    readonly sheet: string;
  }
  interface Options {
    readonly onCell?: (ref: Position) => unknown;
    readonly onRange?: (ref: unknown) => unknown;
  }
  export default class FormulaParser {
    constructor(options?: Options);
    parse(formula: string, position: Position): unknown;
  }
}
