import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Spec 04 §9 — digest-based trademark scan. Text is split into lowercase words (also at camelCase boundaries) and
 * adjacent word pairs; each is hashed with SHA-256 and compared with a digest list. Matches are reported by position,
 * never by term, so no banned term is ever written by the scanner, its tests, or its output.
 */
export interface TrademarkHit {
  readonly line: number;
  readonly column: number;
  readonly digest: string;
}

export function loadDigests(): ReadonlySet<string> {
  const raw = JSON.parse(readFileSync(new URL('./banned-term-digests.json', import.meta.url), 'utf8')) as { readonly digests: ReadonlyArray<string> };
  return new Set(raw.digests);
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function scanText(text: string, digests: ReadonlySet<string>): TrademarkHit[] {
  const hits: TrademarkHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const words: Array<{ w: string; col: number }> = [];
    for (const m of line.matchAll(/[A-Za-z0-9]+/g)) words.push({ w: m[0].toLowerCase(), col: (m.index ?? 0) + 1 });
    for (let j = 0; j < words.length; j++) {
      const a = words[j];
      if (a === undefined) continue;
      const single = sha(a.w);
      if (digests.has(single)) hits.push({ line: i + 1, column: a.col, digest: single });
      const b = words[j + 1];
      if (b !== undefined) {
        const pair = sha(`${a.w} ${b.w}`);
        if (digests.has(pair)) hits.push({ line: i + 1, column: a.col, digest: pair });
      }
    }
  }
  return hits;
}
