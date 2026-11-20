/** FNV-1a over UTF-16 code units. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** lowbias32 finalizer (identical to the DuckDB suture_h32 macro). */
export function lowbias32(x0: number): number {
  let x = x0 >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function mix32(a: number, b: number): number {
  return lowbias32((a ^ Math.imul(b, 0x9e3779b9)) >>> 0);
}

/** Binary exponentiation for integer exponents: bit-identical across JS engines. */
export function ipow(base: number, n: number): number {
  if (n < 0) return 1 / ipow(base, -n);
  let result = 1;
  let b = base;
  let e = n;
  while (e > 0) {
    if (e & 1) result *= b;
    b *= b;
    e = Math.floor(e / 2);
  }
  return result;
}
