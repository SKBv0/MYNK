/** Locale-aware formatting (Intl-based); the UI language is mirrored here for non-React code. */
import type { Language } from '../translations';

/** BCP-47 locale for a UI language. */
const LOCALES: Record<Language, string> = { en: 'en-US', tr: 'tr-TR' };

export const localeOf = (lang: Language): string => LOCALES[lang];

let activeLocale = localeOf('en');

/** Called by the store whenever the UI language changes. */
export const setFormatLanguage = (lang: Language): void => {
  activeLocale = localeOf(lang);
};

export const activeFormatLocale = (): string => activeLocale;

// Intl constructors are comparatively expensive; formatters are cached per locale + options.
const cache = new Map<string, unknown>();
const cached = <T>(key: string, create: () => T): T => {
  let value = cache.get(key) as T | undefined;
  if (value === undefined) {
    value = create();
    cache.set(key, value);
  }
  return value;
};

/** True when `new Date(timestamp)` is a real date (finite and within the ±8.64e15 ms range). */
const isValidTimestamp = (timestamp: number): boolean =>
  Number.isFinite(new Date(timestamp).getTime());

/** Formats a date; an invalid timestamp gives an empty string instead of throwing. */
export const formatDate = (
  timestamp: number,
  locale: string = activeLocale,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
): string => {
  if (!isValidTimestamp(timestamp)) return '';
  try {
    return cached(
      `d|${locale}|${JSON.stringify(options)}`,
      () => new Intl.DateTimeFormat(locale, options),
    ).format(new Date(timestamp));
  } catch {
    // Only an unsupported locale/options combination lands here; the timestamp is already valid.
    return new Date(timestamp).toISOString().slice(0, 10);
  }
};

export const formatTime = (timestamp: number, locale: string = activeLocale): string =>
  formatDate(timestamp, locale, { hour: '2-digit', minute: '2-digit' });

export const formatNumber = (
  value: number,
  locale: string = activeLocale,
  options: Intl.NumberFormatOptions = {},
): string =>
  cached(
    `n|${locale}|${JSON.stringify(options)}`,
    () => new Intl.NumberFormat(locale, options),
  ).format(value);

/** USD amount with enough precision for tiny per-message LLM costs. */
export const formatUsd = (amount: number, locale: string = activeLocale): string => {
  const digits = amount === 0 ? 2 : amount < 0.01 ? 4 : 2;
  return formatNumber(amount, locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** Relative phrasing localized by `locale`; under a minute rounds down to "now". */
export const formatRelativeTime = (
  timestamp: number,
  now: number = Date.now(),
  locale: string = activeLocale,
): string => {
  if (!isValidTimestamp(timestamp) || !isValidTimestamp(now)) return '';
  const rtf = cached(
    `r|${locale}`,
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' }),
  );
  const diff = timestamp - now;
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, 'second');
};

/** CLDR plural category (`one`, `other`, …) of `count` in `locale`. */
export const pluralCategory = (count: number, locale: string = activeLocale): Intl.LDMLPluralRule =>
  cached(`p|${locale}`, () => new Intl.PluralRules(locale)).select(count);

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** Byte count in the largest fitting 1000-based unit, the way Ollama reports model sizes. */
export const formatBytes = (bytes: number, locale: string = activeLocale): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return formatNumber(value, locale, {
    style: 'unit',
    unit: BYTE_UNITS[unit],
    unitDisplay: unit === 0 ? 'long' : 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  });
};

/** Token count as models advertise it: `32K` for 32768, `128K` for 128000, `1M`. */
export const formatTokenCount = (tokens: number, locale: string = activeLocale): string => {
  const scaled = (step: number, binary: number) =>
    tokens % step !== 0 && tokens % binary === 0 ? tokens / binary : tokens / step;
  if (tokens >= 1_000_000) {
    return `${formatNumber(scaled(1_000_000, 1_048_576), locale, { maximumFractionDigits: 1 })}M`;
  }
  if (tokens >= 1000) {
    return `${formatNumber(scaled(1000, 1024), locale, { maximumFractionDigits: 0 })}K`;
  }
  return formatNumber(tokens, locale);
};
