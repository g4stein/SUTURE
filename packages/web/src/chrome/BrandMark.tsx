import type { ReactNode } from 'react';

/** SUTURE wordmark with a geometric stitch: one running thread crossed by three surgical stitches. */
export function BrandMark(): ReactNode {
  return (
    // The page heading: screen readers hear "Suture X-Ray Studio"; sighted users see the stitch mark and wordmark.
    <h1 className="flex items-center gap-2">
      <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true" className="shrink-0">
        <path d="M1 9 H25" className="stroke-ink-muted" strokeWidth="1.25" fill="none" />
        <path d="M5 3 L9 15 M11 3 L15 15 M17 3 L21 15" className="stroke-engine-formula" strokeWidth="1.75" strokeLinecap="round" fill="none" />
        <circle cx="25" cy="9" r="1.5" className="fill-fracture" />
      </svg>
      <span aria-hidden="true" className="font-mono text-sm font-semibold tracking-[0.28em] text-ink">SUTURE</span>
      <span className="sr-only">Suture X-Ray Studio</span>
    </h1>
  );
}
