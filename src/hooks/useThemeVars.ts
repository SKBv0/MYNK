import { useEffect } from 'react';
import { useAppStore } from '../store';
import { rgbTriplet } from '../lib/color';
import { accentTokens, type ResolvedTheme } from '../lib/theme';
import { PREFERS_LIGHT_QUERY, useMediaQuery } from './useMediaQuery';

/** The theme shown: the stored mode, or the OS preference for `system`. */
export const useResolvedTheme = (): ResolvedTheme => {
  const mode = useAppStore((s) => s.themeMode);
  const prefersLight = useMediaQuery(PREFERS_LIGHT_QUERY);
  if (mode === 'system') return prefersLight ? 'light' : 'dark';
  return mode;
};

/**
 * Mirrors theme + accent tokens onto `<html>`, and the UI language into `lang` so
 * `text-transform: uppercase` uppercases Turkish `i` correctly.
 */
export const useThemeVars = (): void => {
  const accent = useAppStore((s) => s.theme.accent);
  const lang = useAppStore((s) => s.lang);
  const resolved = useResolvedTheme();

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    const root = document.documentElement;
    const tokens = accentTokens(accent, resolved);
    root.dataset.theme = resolved;
    root.style.setProperty('--accent', tokens.accent);
    root.style.setProperty('--accent-rgb', rgbTriplet(tokens.accent));
    root.style.setProperty('--accent-contrast', tokens.contrast);
    root.style.setProperty('--accent-text', tokens.text);
    root.style.setProperty('--accent-text-rgb', rgbTriplet(tokens.text));
  }, [accent, resolved]);
};
