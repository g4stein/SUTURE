export interface IsolationInfo {
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
}

export function detectIsolation(): IsolationInfo {
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
}

export function isIsolated(i: IsolationInfo): boolean {
  return i.crossOriginIsolated && i.sharedArrayBuffer;
}

export const DEGRADED_REASON = 'timeouts restart the engine (page is not cross-origin isolated)';
