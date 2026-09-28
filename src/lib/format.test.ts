import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDate,
  formatNumber,
  formatRelativeTime,
  formatTokenCount,
  formatUsd,
  localeOf,
  pluralCategory,
} from './format';
import { fmt, samePlural, selectPlural } from './text';
import { translations } from '../translations';

describe('fmt', () => {
  it('interpolates named variables and leaves unknown ones', () => {
    expect(fmt('Hi {name} {missing}', { name: 'Ada' }, 'en-US')).toBe('Hi Ada {missing}');
  });

  it('selects the plural form by count', () => {
    const forms = { one: '{count} bookmark', other: '{count} bookmarks' };
    expect(fmt(forms, { count: 1 }, 'en-US')).toBe('1 bookmark');
    expect(fmt(forms, { count: 0 }, 'en-US')).toBe('0 bookmarks');
    expect(fmt(forms, { count: 5 }, 'en-US')).toBe('5 bookmarks');
  });

  it('formats numbers with the locale digit grouping', () => {
    expect(fmt('{count} items', { count: 12345 }, 'en-US')).toBe('12,345 items');
    expect(fmt('{count} öğe', { count: 12345 }, 'tr-TR')).toBe('12.345 öğe');
  });

  it('falls back to `other` without a numeric count', () => {
    expect(selectPlural({ one: 'one', other: 'many' }, Number.NaN, 'en-US')).toBe('many');
    expect(fmt({ one: 'one', other: 'many' }, {}, 'en-US')).toBe('many');
  });

  it('renders real translation keys without the "1 collections" bug', () => {
    expect(fmt(translations.en.nav.moreCollections, { count: 1 }, 'en-US')).toBe(
      '1 more collection',
    );
    expect(fmt(translations.en.collections.items, { count: 1 }, 'en-US')).toBe('1 bookmark');
    expect(fmt(translations.en.collections.items, { count: 2 }, 'en-US')).toBe('2 bookmarks');
    expect(fmt(translations.tr.collections.items, { count: 1 }, 'tr-TR')).toBe('1 yer imi');
    expect(fmt(translations.tr.collections.items, { count: 3 }, 'tr-TR')).toBe('3 yer imi');
  });

  it('samePlural uses one text for every category', () => {
    expect(samePlural('x')).toEqual({ one: 'x', other: 'x' });
  });
});

describe('Intl helpers', () => {
  it('maps UI languages to locales', () => {
    expect(localeOf('en')).toBe('en-US');
    expect(localeOf('tr')).toBe('tr-TR');
  });

  it('selects CLDR plural categories', () => {
    expect(pluralCategory(1, 'en-US')).toBe('one');
    expect(pluralCategory(2, 'en-US')).toBe('other');
    expect(pluralCategory(1, 'tr-TR')).toBe('one');
  });

  it('formats dates in the given locale', () => {
    const ts = Date.UTC(2026, 0, 15, 12);
    expect(formatDate(ts, 'en-US')).toContain('2026');
    expect(formatDate(ts, 'tr-TR', { month: 'long', timeZone: 'UTC' })).toBe('Ocak');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 0, 15, 12);
    expect(formatRelativeTime(now - 5 * 60_000, now, 'en-US')).toBe('5 minutes ago');
    expect(formatRelativeTime(now - 5 * 60_000, now, 'tr-TR')).toBe('5 dakika önce');
    expect(formatRelativeTime(now - 86_400_000, now, 'en-US')).toBe('yesterday');
    expect(formatRelativeTime(now - 10_000, now, 'en-US')).toBe('now');
  });

  it('formats numbers and small USD amounts', () => {
    expect(formatNumber(1234.5, 'en-US')).toBe('1,234.5');
    expect(formatUsd(0.00123, 'en-US')).toBe('$0.0012');
    expect(formatUsd(1.5, 'en-US')).toBe('$1.50');
  });
});

describe('formatBytes', () => {
  it('picks the largest 1000-based unit with one decimal', () => {
    expect(formatBytes(512, 'en-US')).toBe('512 bytes');
    expect(formatBytes(4_683_087_332, 'en-US')).toBe('4.7 GB');
    expect(formatBytes(123_400_000, 'tr-TR')).toMatch(/^123,4\sMB$/);
  });
});

describe('formatTokenCount', () => {
  it('uses K / M the way context windows are advertised', () => {
    expect(formatTokenCount(32_768, 'en-US')).toBe('32K');
    expect(formatTokenCount(128_000, 'en-US')).toBe('128K');
    expect(formatTokenCount(1_048_576, 'en-US')).toBe('1M');
    expect(formatTokenCount(512, 'en-US')).toBe('512');
  });
});
