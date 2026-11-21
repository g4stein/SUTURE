import { describe, expect, it } from 'vitest';
import tailwind from '../tailwind.config.ts';

/** Spec 04 Req 11.3 — WCAG AA (4.5:1 for text) for every token pair the UI actually renders. */
const colors = (tailwind.theme?.extend?.colors ?? {}) as Readonly<Record<string, string>>;

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const tok = (name: string): string => {
  const v = colors[name];
  if (v === undefined) throw new Error(`missing token ${name}`);
  return v;
};

describe('design tokens (steering §1)', () => {
  it('match the Phase 4 Obsidian palette', () => {
    expect(tok('obsidian')).toBe('#090B10');
    expect(tok('slate-surface')).toBe('#10141D');
    expect(tok('slate-raised')).toBe('#171C28');
    expect(tok('engine-sql')).toBe('#06B6D4');
    expect(tok('engine-py')).toBe('#F59E0B');
    expect(tok('engine-formula')).toBe('#10B981');
    expect(tok('fracture')).toBe('#F43F5E');
  });

  const text = ['ink', 'ink-muted', 'engine-sql', 'engine-py', 'engine-formula', 'fracture'];
  const surfaces = ['obsidian', 'slate-surface', 'slate-raised'];
  for (const t of text) {
    for (const s of surfaces) {
      it(`${t} on ${s} meets 4.5:1`, () => {
        expect(contrast(tok(t), tok(s))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('the Exorcise Model button (obsidian text on fracture) meets 4.5:1', () => {
    expect(contrast(tok('obsidian'), tok('fracture'))).toBeGreaterThanOrEqual(4.5);
  });
});
