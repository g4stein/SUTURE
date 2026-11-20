import type { Config } from 'tailwindcss';

// Design tokens from .kiro/steering/ui-craft-and-branding.md §1 (the only source of colors).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: '#0B0E13',
        'slate-surface': '#121821',
        'slate-raised': '#1A2230',
        'slate-line': '#263142',
        ink: '#D6DEEA',
        'ink-muted': '#7C8AA0',
        'engine-sql': '#22D3EE',
        'engine-py': '#F59E0B',
        'engine-formula': '#10B981',
        fracture: '#DC143C',
      },
      fontFamily: {
        mono: ['ui-monospace', 'JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
