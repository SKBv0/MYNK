import { describe, expect, it } from 'vitest';
import {
  CorruptLibraryError,
  FutureVersionError,
  normalizePersisted,
  parsePersisted,
} from './migrate';
import { fixTimestamp } from './model';
import { WEBKIT_EPOCH_OFFSET_MS } from '../lib/time';
import { DEFAULT_THEME } from './slices/ui';
import { makeResource } from '../test/fixtures';

const NOW = Date.UTC(2026, 8, 1);
const REAL_2022 = Date.UTC(2022, 5, 1);

describe('fixTimestamp', () => {
  it('fixes the 2393-year Chrome dates', () => {
    const year2393 = Date.UTC(2393, 0, 1);
    const fixed = fixTimestamp(year2393, NOW);
    expect(fixed.fixed).toBe(true);
    expect(fixed.value).toBe(year2393 - WEBKIT_EPOCH_OFFSET_MS);
    expect(new Date(fixed.value).getUTCFullYear()).toBeLessThan(2027);
  });

  it('keeps plausible dates and replaces garbage with now', () => {
    expect(fixTimestamp(REAL_2022, NOW)).toEqual({ value: REAL_2022, fixed: false });
    expect(fixTimestamp(Number.MAX_SAFE_INTEGER, NOW).value).toBe(NOW);
    expect(fixTimestamp('x', NOW).value).toBe(NOW);
  });
});

describe('v3 round trip', () => {
  it('parsePersisted reads back what normalizePersisted produced', () => {
    const data = normalizePersisted(
      {
        version: 3,
        resources: [makeResource({ url: 'https://a.example.com/', isFavorite: true })],
        settings: { lang: 'tr', viewMode: 'timeline' },
      },
      NOW,
    );
    const parsed = parsePersisted(JSON.stringify(data), NOW);
    expect(parsed).toEqual(data);
  });

  it('normalizePersisted drops invalid records and resets stale pending analysis', () => {
    const data = normalizePersisted(
      {
        version: 3,
        resources: [
          {
            id: 'x',
            url: 'https://ok.com',
            ai: { status: 'pending' },
            media: { snapshotFile: '../evil' },
          },
          { id: 'y', url: 'javascript:alert(1)' },
        ],
        collections: [{ name: '' }],
        settings: { lang: 'de' },
      },
      NOW,
    );
    expect(data.resources).toHaveLength(1);
    expect(data.resources[0]?.ai.status).toBe('none');
    expect(data.resources[0]?.media).toEqual({});
    expect(data.collections).toHaveLength(0);
    expect(data.settings.lang).toBe('en');
  });
});

describe('parsePersisted guards', () => {
  const v3 = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 3,
      resources: [],
      collections: [],
      chats: {},
      settings: {},
      healthMeta: {},
      ...extra,
    });

  it('reads a well formed v3 payload', () => {
    expect(parsePersisted(v3(), NOW).version).toBe(3);
  });

  it('drops the obsolete theme fields (bg, accentRGB) without failing', () => {
    const stored = v3({
      settings: {
        lang: 'tr',
        themeMode: 'light',
        theme: { bg: '#0b0b0d', accent: '#8b5cf6', accentRGB: '139, 92, 246' },
      },
    });
    const data = parsePersisted(stored, NOW);
    // Same schema version: the shape only lost fields nothing read back.
    expect(data.version).toBe(3);
    expect(data.settings.theme).toEqual({ accent: '#8b5cf6' });
    expect(data.settings).toMatchObject({ lang: 'tr', themeMode: 'light' });
  });

  it('falls back to the default theme when the accent is missing or not a hex color', () => {
    const themeOf = (theme: unknown) =>
      parsePersisted(v3({ settings: { theme } }), NOW).settings.theme;
    expect(themeOf({ bg: '#000' })).toEqual(DEFAULT_THEME);
    expect(themeOf({ accent: 7 })).toEqual(DEFAULT_THEME);
    expect(themeOf({ accent: 'blue' })).toEqual(DEFAULT_THEME);
    expect(themeOf({ accent: 'rgb(14, 165, 233)' })).toEqual(DEFAULT_THEME);
  });

  it('keeps a stored health error kind and drops an unknown one', () => {
    const record = (errorKind: unknown) => ({
      id: 'r',
      url: 'https://gone.example.com/',
      health: { status: 'dead', checkedAt: NOW, errorKind },
    });
    const kindOf = (errorKind: unknown) =>
      parsePersisted(v3({ resources: [record(errorKind)] }), NOW).resources[0]?.health;
    expect(kindOf('dns')).toEqual({ status: 'dead', checkedAt: NOW, errorKind: 'dns' });
    expect(kindOf('none')).toEqual({ status: 'dead', checkedAt: NOW });
    expect(kindOf('teapot')).toEqual({ status: 'dead', checkedAt: NOW });
    // Files written before the field existed load unchanged.
    expect(kindOf(undefined)).toEqual({ status: 'dead', checkedAt: NOW });
  });

  it('refuses a library written by a newer schema instead of migrating it away', () => {
    const future = v3({ version: 4, resources: [{ id: 'keep-me' }] });
    expect(() => parsePersisted(future, NOW)).toThrow(FutureVersionError);
    try {
      parsePersisted(future, NOW);
    } catch (error) {
      expect((error as FutureVersionError).version).toBe(4);
    }
  });

  it('refuses a current-version file whose resource list is damaged', () => {
    expect(() => parsePersisted(v3({ resources: null }), NOW)).toThrow(CorruptLibraryError);
    expect(() => parsePersisted(v3({ resources: { 0: 'x' } }), NOW)).toThrow(CorruptLibraryError);
  });

  it('refuses a file with an older or unknown version number', () => {
    expect(() => parsePersisted(v3({ version: 2 }), NOW)).toThrow(CorruptLibraryError);
    expect(() => parsePersisted(v3({ version: 2.5 }), NOW)).toThrow(CorruptLibraryError);
  });

  it('refuses JSON that is not an object', () => {
    expect(() => parsePersisted('[]', NOW)).toThrow(CorruptLibraryError);
    expect(() => parsePersisted('"library"', NOW)).toThrow(CorruptLibraryError);
  });
});
