import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Spec 04 Req 11.1 / steering §1: components take every color from the design tokens; no hex literals in src/**\/*.tsx. */
const SRC = new URL('../src/', import.meta.url).pathname;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('no hard-coded hex colors in components', () => {
  it('the scanner catches a hex literal', () => {
    expect('className="text-[#06B6D4]"'.match(HEX)).toEqual(['#06B6D4']);
    expect('href="#replay=v1.abc" code="#DIV/0!"'.match(HEX)).toBeNull();
  });

  it('src/**/*.tsx contains no hex color literal', () => {
    const files = tsxFiles(SRC);
    expect(files.length).toBeGreaterThan(4);
    const found = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (line.match(HEX) ?? []).map((m) => `${relative(SRC, f)}:${i + 1} ${m}`)));
    expect(found).toEqual([]);
  });
});
