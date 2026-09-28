import { describe, expect, it } from 'vitest';
import {
  DARK_INK,
  LIGHT_INK,
  accentContrastText,
  contrastRatio,
  ensureContrast,
  parseHex,
  rgbTriplet,
} from './color';
import { ACCENTS, accentTokens } from './theme';

describe('color', () => {
  it('parses short and long hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('facc15')).toEqual({ r: 250, g: 204, b: 21 });
    expect(parseHex('nope')).toBeNull();
    expect(rgbTriplet('#0ea5e9')).toBe('14 165 233');
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    // White text fails AA against the yellow accent.
    expect(contrastRatio('#facc15', '#ffffff')).toBeLessThan(1.7);
  });

  it('picks dark ink for the light yellow accent', () => {
    expect(accentContrastText('#facc15')).toBe(DARK_INK);
    expect(accentContrastText('#1e3a8a')).toBe(LIGHT_INK);
  });

  it('every accent preset reaches AA for text on its fill and as text on both themes', () => {
    for (const { value } of ACCENTS) {
      for (const theme of ['dark', 'light'] as const) {
        const tokens = accentTokens(value, theme);
        expect(tokens.ratio).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(tokens.text, theme === 'dark' ? '#1e1e23' : '#e6e6eb'),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('ensureContrast darkens on light backgrounds', () => {
    const fixed = ensureContrast('#facc15', '#ffffff', 4.5);
    expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
