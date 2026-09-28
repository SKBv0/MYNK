/** Theme presets: the worst-case surface per theme and the accent palette. */
import { accentContrastText, contrastRatio, ensureContrast } from './color';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system'];

export const isThemeMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);

/** Most demanding surface for accent-colored text per theme; keep in sync with index.css. */
export const THEME_SURFACES: Record<ResolvedTheme, { worstSurface: string }> = {
  dark: { worstSurface: '#1e1e23' },
  light: { worstSurface: '#e6e6eb' },
};

export type AccentId = 'yellow' | 'sky' | 'violet' | 'rose' | 'emerald';

export const ACCENTS: readonly { id: AccentId; value: string }[] = [
  { id: 'yellow', value: '#facc15' },
  { id: 'sky', value: '#0ea5e9' },
  { id: 'violet', value: '#8b5cf6' },
  { id: 'rose', value: '#f43f5e' },
  { id: 'emerald', value: '#10b981' },
];

export const DEFAULT_ACCENT = '#facc15';

export interface Gradient {
  start: string;
  end: string;
}

export const DEFAULT_GRADIENT: Gradient = { start: '#1f2937', end: '#0f172a' };

/** Placeholder backgrounds for bookmarks without a preview, picked by a hash of the host. */
export const PLACEHOLDER_GRADIENTS: readonly Gradient[] = [
  DEFAULT_GRADIENT,
  { start: '#334155', end: '#1e293b' },
  { start: '#4c1d95', end: '#1e1b4b' },
  { start: '#0f766e', end: '#134e4a' },
  { start: '#7f1d1d', end: '#450a0a' },
  { start: '#0c4a6e', end: '#082f49' },
  { start: '#3f3f46', end: '#18181b' },
  { start: '#312e81', end: '#111827' },
];

/**
 * Ink for the generated placeholder covers (`services/resourceMedia`). They are SVG data URIs, so
 * they cannot read CSS tokens; the host label keeps ≥ 4.5:1 on the darkest gradient.
 */
export const PLACEHOLDER_INK = {
  glyph: 'rgba(255,255,255,0.88)',
  globe: 'rgba(255,255,255,0.86)',
  host: 'rgba(255,255,255,0.72)',
  sheen: 'rgba(255,255,255,0.08)',
  sheenSoft: 'rgba(255,255,255,0.07)',
} as const;

/** Body font stack of the app, spelled out for the same generated SVGs. */
export const PLACEHOLDER_FONT_STACK = "'DM Sans', 'Segoe UI', system-ui, -apple-system, sans-serif";

export interface AccentTokens {
  /** Background fills (buttons, selected states). */
  accent: string;
  /** Text / icons placed on an accent background. */
  contrast: string;
  /** Accent used as text or icon color on theme surfaces (≥ 4.5:1 on `--surface-3`). */
  text: string;
  /** Contrast of `contrast` on `accent`. */
  ratio: number;
}

export const accentTokens = (accent: string, theme: ResolvedTheme): AccentTokens => {
  const contrast = accentContrastText(accent);
  return {
    accent,
    contrast,
    text: ensureContrast(accent, THEME_SURFACES[theme].worstSurface, 4.5),
    ratio: contrastRatio(accent, contrast),
  };
};
