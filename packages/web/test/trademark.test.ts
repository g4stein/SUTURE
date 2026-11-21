import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDigests, scanText } from './fixtures/trademark.ts';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const TEXT = /\.(ts|tsx|js|mjs|json|md|css|html|yml|yaml|py|txt)$/;

describe('trademark hygiene (Spec 04 §9, Req 11.2)', () => {
  it('the scanner flags a word whose digest is listed (a made-up word, written to a temp file and deleted)', () => {
    const made = 'zqxvortleplank';
    const digests = new Set([...loadDigests(), createHash('sha256').update(made).digest('hex')]);
    const dir = mkdtempSync(join(tmpdir(), 'suture-tm-'));
    try {
      const file = join(dir, 'sample.md');
      writeFileSync(file, `clean line\nsee the ${made} file\nand camelCase ${made[0]?.toUpperCase()}${made.slice(1)}Parser too\n`);
      const hits = scanText(readFileSync(file, 'utf8'), digests);
      expect(hits.map((h) => h.line)).toEqual([2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every tracked text file under packages/, .kiro/, and the README is clean', () => {
    const files = execFileSync('git', ['ls-files', '--', 'packages', '.kiro', 'README.md', 'vercel.json', '.github'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => TEXT.test(f) && !f.endsWith('banned-term-digests.json'));
    expect(files.length).toBeGreaterThan(100);
    const digests = loadDigests();
    const dirty: string[] = [];
    for (const f of files) {
      for (const h of scanText(readFileSync(join(ROOT, f), 'utf8'), digests)) dirty.push(`${f}:${h.line}:${h.column}`);
    }
    expect(dirty, `banned product name at ${dirty.join(', ')}`).toEqual([]);
  });
});
