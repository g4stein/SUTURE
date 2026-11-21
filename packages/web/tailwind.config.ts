import type { Config } from 'tailwindcss';

// Design tokens from .kiro/steering/ui-craft-and-branding.md §1 (the only source of colors).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#090B10',
        'slate-surface': '#10141D',
        'slate-raised': '#171C28',
        'slate-line': '#263142',
        ink: '#D6DEEA',
        'ink-muted': '#7C8AA0',
        'engine-sql': '#06B6D4',
        'engine-py': '#F59E0B',
        'engine-formula': '#10B981',
        fracture: '#F43F5E',
      },
      fontFamily: {
        mono: ['ui-monospace', 'JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
