/// <reference types="vite/client" />
/** Scans every app source for arbitrary Tailwind values, raw hex, and hardcoded language text. */
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

/** Legitimate arbitrary values with no token equivalent; removed before matching. */
const ALLOWED = ['transition-[width]', 'after:content-[""]'];

/** The palette itself; every token in `index.css` is derived from or kept in sync with these. */
const PALETTE_SOURCES = ['../lib/color.ts', '../lib/theme.ts'];

const RULES: { name: string; pattern: RegExp; except?: readonly string[] }[] = [
  {
    name: 'arbitrary value on a token scale',
    pattern:
      /\b(?:text|bg|z|border|w|h|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap|top|left|right|bottom|inset|rounded|shadow)-\[/,
  },
  { name: 'hex colour', pattern: /#[0-9a-fA-F]{3,8}\b/, except: PALETTE_SOURCES },
  {
    name: 'white/black utility',
    pattern: /\b(?:text|bg|border|ring|fill|stroke)-(?:white|black)\b/,
  },
  { name: 'language branch', pattern: /lang\s*===\s*['"]tr['"]/ },
];

const violations = (): string[] => {
  const found: string[] = [];
  for (const [path, raw] of Object.entries(sources)) {
    const lines = raw.split('\n');
    lines.forEach((line, index) => {
      const text = ALLOWED.reduce((acc, allowed) => acc.split(allowed).join(''), line);
      for (const rule of RULES) {
        if (rule.except?.includes(path)) continue;
        if (rule.pattern.test(text))
          found.push(`${path}:${index + 1} ${rule.name}: ${line.trim()}`);
      }
    });
  }
  return found;
};

describe('component style rules', () => {
  it('scans every app source, not only the components', () => {
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.some((path) => path.startsWith('../hooks/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('../store/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('./'))).toBe(true);
  });

  it('uses design tokens only', () => {
    expect(violations()).toEqual([]);
  });
});
