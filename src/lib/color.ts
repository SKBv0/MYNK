/** Color helpers for the runtime theme: WCAG contrast, accent-contrast text, readable accents. */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export const parseHex = (value: string): Rgb | null => {
  const match = HEX.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (!hex) return null;
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  const num = Number.parseInt(hex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
};

const toHexPart = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');

const toHex = ({ r, g, b }: Rgb): string => `#${toHexPart(r)}${toHexPart(g)}${toHexPart(b)}`;

/** Space-separated RGB triplet used by `rgb(var(--x-rgb) / <alpha>)`. */
export const rgbTriplet = (value: string): string => {
  const rgb = parseHex(value);
  return rgb ? `${rgb.r} ${rgb.g} ${rgb.b}` : '250 204 21';
};

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (value: string | Rgb): number => {
  const rgb = typeof value === 'string' ? parseHex(value) : value;
  if (!rgb) return 0;
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
};

export const contrastRatio = (a: string | Rgb, b: string | Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

export const DARK_INK = '#0b0b0d';
export const LIGHT_INK = '#ffffff';

/** Text color for content placed on an accent-colored background (whichever contrasts more). */
export const accentContrastText = (accent: string): string =>
  contrastRatio(accent, DARK_INK) >= contrastRatio(accent, LIGHT_INK) ? DARK_INK : LIGHT_INK;

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => ({
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
});

/** Moves `fg` towards black or white until it reaches `min` contrast against `bg`. */
export const ensureContrast = (fg: string, bg: string, min = 4.5): string => {
  const base = parseHex(fg);
  const back = parseHex(bg);
  if (!base || !back) return fg;
  if (contrastRatio(base, back) >= min) return toHex(base);
  const target = relativeLuminance(back) > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(base, target, step / 20);
    if (contrastRatio(candidate, back) >= min) return toHex(candidate);
  }
  return toHex(target);
};

export const formatRatio = (ratio: number): string => `${ratio.toFixed(1)}:1`;
