import {
  createWorkbookEngine, NEVER_CANCELLED, toCellKey,
  type CellKey, type CellValue, type Compressor, type EngineDeps, type Hasher, type WorkbookDefinition, type WorkbookEngine,
} from '../index.ts';

/** Pure-TS SHA-256 (FIPS 180-4) so core tests need no host crypto. */
export const testHasher: Hasher = {
  sha256(bytes: Uint8Array): Promise<Uint8Array> {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const len = bytes.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 4, (len * 8) >>> 0);
    dv.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
    const w = new Uint32Array(64);
    const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15] ?? 0;
        const b = w[i - 2] ?? 0;
        const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
        const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
        w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      const add = [a, b, c, d, e, f, g, hh];
      for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (add[i] ?? 0)) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i] ?? 0);
    return Promise.resolve(out);
  },
};

/** RFC 1951 deflate-raw using stored (uncompressed) blocks — a valid stream every inflater accepts. */
export const storedDeflate: Compressor = {
  deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const parts: number[] = [];
    const n = Math.max(1, Math.ceil(bytes.length / 65535));
    for (let i = 0; i < n; i++) {
      const chunk = bytes.subarray(i * 65535, (i + 1) * 65535);
      parts.push(i === n - 1 ? 1 : 0, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255, ...chunk);
    }
    return Promise.resolve(Uint8Array.from(parts));
  },
  inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const out: number[] = [];
    let p = 0;
    for (;;) {
      const header = bytes[p] ?? 0;
      if ((header & 6) !== 0) return Promise.reject(new Error('only stored blocks are supported by the test inflater'));
      const len = (bytes[p + 1] ?? 0) | ((bytes[p + 2] ?? 0) << 8);
      out.push(...bytes.subarray(p + 5, p + 5 + len));
      p += 5 + len;
      if ((header & 1) === 1) break;
      if (p >= bytes.length) return Promise.reject(new Error('truncated stream'));
    }
    return Promise.resolve(Uint8Array.from(out));
  },
};

let fakeNow = 0;
/**
 * Deps for pure-formula workbooks. Any SQL/PY dispatch is a test failure: these tests exercise formula
 * graphs only, and SQL/Python run against the real engines in the web package tests.
 */
export const formulaOnlyDeps: EngineDeps = {
  sql: {
    evaluate: () => Promise.reject(new Error('SQL dispatched in a formula-only test')),
    evaluateBatch: () => Promise.reject(new Error('SQL dispatched in a formula-only test')),
  },
  py: {
    evaluate: () => Promise.reject(new Error('Python dispatched in a formula-only test')),
    evaluateBatch: () => Promise.reject(new Error('Python dispatched in a formula-only test')),
  },
  clock: { now: () => (fakeNow += 1) },
  yieldControl: () => Promise.resolve(),
};

export function key(sheet: string, a1: string): CellKey {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  if (m === null) throw new Error(`bad A1 ${a1}`);
  let col = 0;
  for (const ch of m[1] ?? '') col = col * 26 + ch.charCodeAt(0) - 64;
  return toCellKey({ sheet, row: Number(m[2]) - 1, col: col - 1 });
}

export function workbook(cells: Record<string, string>, sheet = 'Sheet1'): WorkbookDefinition {
  return {
    sheets: [{ name: sheet, cells: Object.entries(cells).map(([a1, raw]) => ({ key: key(sheet, a1), raw })) }],
    names: [],
    datasets: [],
    seed: 7,
  };
}

export async function build(cells: Record<string, string>): Promise<WorkbookEngine> {
  const e = createWorkbookEngine(workbook(cells), formulaOnlyDeps);
  await e.recalculateAll({ tieBreak: { kind: 'rowMajor' }, token: NEVER_CANCELLED, sliceMs: 0 });
  return e;
}

export function val(e: WorkbookEngine, a1: string): CellValue {
  const v = e.getValue(key('Sheet1', a1));
  if (v === 'pending') throw new Error(`${a1} still pending`);
  return v;
}
