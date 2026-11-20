import type { CellKey } from '../model/address.ts';
import type { ScalarValue } from '../model/values.ts';
import type { Compressor, EncodedScalar, Hasher, ReplayArtifact, SutureDocument } from './types.ts';

export function encodeScalar(v: ScalarValue): EncodedScalar {
  if (v === null) return { t: 'z' };
  if (typeof v === 'number') return { t: 'n', v: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'boolean') return { t: 'b', v };
  return { t: 's', v };
}

export function decodeScalar(e: EncodedScalar): ScalarValue {
  switch (e.t) {
    case 'z': return null;
    case 'n': return e.v === '-0' ? -0 : Number(e.v);
    case 'b': return e.v;
    case 's': return e.v;
  }
}

/** Sorted keys (UTF-16 order), no whitespace, numbers via String(n) with -0 preserved; rejects non-JSON values. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return Object.is(v, -0) ? '-0' : String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    if (ArrayBuffer.isView(v)) throw new Error('canonicalJson: typed arrays are not allowed');
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v}`);
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i] ?? 0;
    let cp: number;
    if (c < 0x80) { cp = c; i += 1; }
    else if (c < 0xe0) { cp = ((c & 31) << 6) | ((b[i + 1] ?? 0) & 63); i += 2; }
    else if (c < 0xf0) { cp = ((c & 15) << 12) | (((b[i + 1] ?? 0) & 63) << 6) | ((b[i + 2] ?? 0) & 63); i += 3; }
    else { cp = ((c & 7) << 18) | (((b[i + 1] ?? 0) & 63) << 12) | (((b[i + 2] ?? 0) & 63) << 6) | ((b[i + 3] ?? 0) & 63); i += 4; }
    s += String.fromCodePoint(cp);
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63];
    s += B64[(n >> 12) & 63];
    if (i + 1 < b.length) s += B64[(n >> 6) & 63];
    if (i + 2 < b.length) s += B64[n & 63];
  }
  return s;
}

export function fromBase64url(s: string): Uint8Array | null {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function workbookHash(doc: SutureDocument, h: Hasher): Promise<string> {
  const digest = await h.sha256(utf8Encode(canonicalJson({ workbook: doc.workbook, exorcist: doc.exorcist })));
  return `sha256:${hex(digest)}`;
}

export const MAX_FRAGMENT_CHARS = 8192;
const MAX_INFLATED_BYTES = 1024 * 1024;

export async function toReplayFragment(a: ReplayArtifact, c: Compressor): Promise<string | { readonly tooLong: number }> {
  const fragment = `replay=v1.${base64url(await c.deflateRaw(utf8Encode(canonicalJson(a))))}`;
  return fragment.length + 1 > MAX_FRAGMENT_CHARS ? { tooLong: fragment.length + 1 } : fragment;
}

export async function fromReplayFragment(fragment: string, c: Compressor): Promise<ReplayArtifact | { readonly error: string }> {
  const body = fragment.replace(/^#/, '');
  if (!body.startsWith('replay=v1.')) return { error: 'not a Suture v1 replay link' };
  const raw = fromBase64url(body.slice('replay=v1.'.length));
  if (raw === null) return { error: 'replay link is not valid base64url' };
  let inflated: Uint8Array;
  try {
    inflated = await c.inflateRaw(raw);
  } catch {
    return { error: 'replay link could not be decompressed' };
  }
  if (inflated.length > MAX_INFLATED_BYTES) return { error: 'replay link expands beyond 1 MiB' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(inflated));
  } catch {
    return { error: 'replay link does not contain JSON' };
  }
  return isReplayArtifact(parsed) ? parsed : { error: 'replay link does not contain a valid Suture replay artifact' };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
export function isEncodedScalar(v: unknown): v is EncodedScalar {
  if (!isObj(v)) return false;
  switch (v['t']) {
    case 'z': return true;
    case 'n': return isStr(v['v']) && (v['v'] === '-0' || Number.isFinite(Number(v['v'])));
    case 's': return isStr(v['v']);
    case 'b': return typeof v['v'] === 'boolean';
    default: return false;
  }
}
function isEdge(v: unknown): boolean {
  return isObj(v) && isStr(v['from']) && isStr(v['to']);
}

/** Full structural validation of untrusted replay input. */
export function isReplayArtifact(v: unknown): v is ReplayArtifact {
  if (!isObj(v)) return false;
  if (v['format'] !== 'suture.replay' || v['version'] !== 1) return false;
  if (v['mode'] !== 'inProcess' && v['mode'] !== 'batched') return false;
  if (!isNum(v['seed']) || !isStr(v['path']) || !isNum(v['numRuns']) || !isNum(v['batchSize'])) return false;
  if (!isStr(v['workbookHash']) || !/^sha256:[0-9a-f]{64}$/.test(v['workbookHash'])) return false;
  if (!isStr(v['sutureVersion']) || !isStr(v['fastCheckVersion']) || !isStr(v['createdAt'])) return false;
  const fi = v['failingInputs'];
  if (!Array.isArray(fi) || !fi.every((x) => isObj(x) && isStr(x['cell']) && isEncodedScalar(x['value']))) return false;
  const lp = v['lineagePath'];
  if (!isObj(lp) || !Array.isArray(lp['cells']) || !lp['cells'].every(isStr) || !Array.isArray(lp['edges']) || !lp['edges'].every(isEdge)) return false;
  if (!(lp['failingEdge'] === null || isEdge(lp['failingEdge']))) return false;
  const va = v['violatedAssertion'];
  if (!isObj(va) || (va['tier'] !== 1 && va['tier'] !== 2) || !isStr(va['detail'])) return false;
  return true;
}

export function sortedInputs(m: ReadonlyArray<{ readonly cell: CellKey; readonly value: ScalarValue }>): Array<{ cell: CellKey; value: EncodedScalar }> {
  return [...m].sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0)).map((x) => ({ cell: x.cell, value: encodeScalar(x.value) }));
}
