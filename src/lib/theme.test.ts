import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_SURFACES, type ResolvedTheme } from './theme';

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

const surface3Of = (theme: ResolvedTheme): string | undefined => {
  const start = css.indexOf(`[data-theme='${theme}'] {`);
  const block = css.slice(start, css.indexOf('}', start));
  return /--surface-3:\s*(#[0-9a-fA-F]{6})/.exec(block)?.[1];
};

describe('THEME_SURFACES', () => {
  it.each(['dark', 'light'] as const)(
    'matches --surface-3 of the %s theme in index.css',
    (theme) => {
      expect(surface3Of(theme)?.toLowerCase()).toBe(THEME_SURFACES[theme].worstSurface);
    },
  );
});
