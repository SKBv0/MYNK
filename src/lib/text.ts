import { activeFormatLocale, formatNumber, pluralCategory } from './format';

/** Case/diacritic-insensitive normalization for search and category matching; Turkish-aware. */
export const normalizeSearchText = (value: string): string =>
  value.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');

/** Same strings in the same order; guards the "nothing changed" checks in the store. */
export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Splits normalized text into search tokens. */
export const tokenize = (value: string): string[] =>
  normalizeSearchText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Plural entry chosen by `Intl.PluralRules`; unused CLDR categories fall back to `other`. */
export type PluralForms = { one: string; other: string } & Partial<
  Record<'zero' | 'two' | 'few' | 'many', string>
>;

export type Template = string | PluralForms;

/** Same text for every count (Turkish nouns do not inflect after a numeral). */
export const samePlural = (text: string): PluralForms => ({ one: text, other: text });

/** Picks the plural form for `count` in `locale` (defaults to the UI language). */
export const selectPlural = (
  template: Template,
  count: number,
  locale: string = activeFormatLocale(),
): string => {
  if (typeof template === 'string') return template;
  return template[pluralCategory(count, locale)] ?? template.other;
};

/**
 * `{name}` interpolation for translation templates. Plural templates select their form by
 * `vars.count`; numbers are formatted with the UI locale's digit grouping.
 */
export const fmt = (
  template: Template,
  vars: Record<string, string | number>,
  locale: string = activeFormatLocale(),
): string => {
  const count = vars.count;
  const text =
    typeof template === 'string'
      ? template
      : selectPlural(template, typeof count === 'number' ? count : Number.NaN, locale);
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const value = vars[key];
    if (value === undefined) return match;
    return typeof value === 'number' ? formatNumber(value, locale) : value;
  });
};

/**
 * Lowercasing for stored values; must stay locale-independent: `I`/`İ`→`i`, where
 * `toLocaleLowerCase('tr')` would turn an English tag like "AI" into "aı".
 */
export const lowerCaseTag = (value: string): string => value.replace(/İ/g, 'i').toLowerCase();

/**
 * Trims, lowercases (see `lowerCaseTag`) and de-duplicates tags; each tag is clipped to 48
 * characters and the list to `max`, dropping whatever comes last.
 */
export const normalizeTags = (tags: Iterable<string>, max = 24): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = lowerCaseTag(raw.trim().replace(/\s+/g, ' ')).slice(0, 48);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
};
