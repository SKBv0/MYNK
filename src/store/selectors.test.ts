import { describe, expect, it } from 'vitest';
import type { Collection, Resource } from '../types';
import { createResource } from './model';
import {
  cachedRuleCount,
  filterResources,
  isCollectionMember,
  healthSummary,
  matchesKeywords,
  rankResources,
  resourceById,
  sortByCreatedAt,
  visibleResources,
  workingPercent,
} from './selectors';

const make = (url: string, patch: Partial<Resource> = {}): Resource => {
  const resource = createResource({ url }, 1_000);
  if (!resource) throw new Error(`bad url ${url}`);
  return { ...resource, ...patch };
};

const istanbul = make('https://istanbul.example.com', {
  title: 'İSTANBUL Yazılımcılar Buluşması',
  description: 'Şehirde çalışan geliştiriciler için etkinlik',
  tags: ['etkinlik'],
  createdAt: 3,
});
const rust = make('https://www.rust-lang.org/learn', {
  title: 'Learn Rust',
  summary: ['Ownership and borrowing explained'],
  tags: ['rust', 'systems'],
  createdAt: 2,
  isFavorite: true,
});
const email = make('https://mail.example.com', { title: 'Email client tips', createdAt: 1 });
const all = [istanbul, rust, email];

const collection = (keywords: string[], pinnedIds: string[] = []): Collection => ({
  id: 'c1',
  name: 'C',
  description: '',
  keywords,
  pinnedIds,
  createdAt: 0,
  updatedAt: 0,
});

describe('filterResources', () => {
  it('is case- and Turkish-diacritic-insensitive', () => {
    expect(filterResources(all, { query: 'istanbul' })).toEqual([istanbul]);
    expect(filterResources(all, { query: 'İSTANBUL' })).toEqual([istanbul]);
    expect(filterResources(all, { query: 'ISTANBUL' })).toEqual([istanbul]);
    expect(filterResources(all, { query: 'sehirde gelistirici' })).toEqual([istanbul]);
    expect(filterResources(all, { query: 'yazilimcilar' })).toEqual([istanbul]);
  });

  it('searches url, host, tags and summary too', () => {
    expect(filterResources(all, { query: 'rust-lang' })).toEqual([rust]);
    expect(filterResources(all, { query: 'borrowing' })).toEqual([rust]);
    expect(filterResources(all, { query: 'systems' })).toEqual([rust]);
  });

  it('ANDs multiple tokens and returns the same array for an empty filter', () => {
    expect(filterResources(all, { query: 'learn email' })).toEqual([]);
    expect(filterResources(all, { query: '  ' })).toBe(all);
  });

  it('applies favorites and collection scope', () => {
    expect(filterResources(all, { favoritesOnly: true })).toEqual([rust]);
    expect(filterResources(all, { collection: collection(['rust'], [email.id]) })).toEqual([
      rust,
      email,
    ]);
  });
});

describe('matchesKeywords', () => {
  it('matches at token start so Turkish suffixes work', () => {
    expect(matchesKeywords(istanbul, ['yazılım'])).toBe(true);
    expect(matchesKeywords(istanbul, ['Yazilim'])).toBe(true);
    expect(matchesKeywords(istanbul, ['geliştirici'])).toBe(true);
  });

  it('does not match inside a word', () => {
    expect(matchesKeywords(email, ['ai'])).toBe(false);
    expect(matchesKeywords(email, ['mail'])).toBe(true);
  });

  it('escapes regex characters and ignores empty keyword lists', () => {
    const cpp = make('https://cpp.example.com', { title: 'C++ tricks' });
    expect(matchesKeywords(cpp, ['c++'])).toBe(true);
    expect(matchesKeywords(cpp, [])).toBe(false);
    expect(matchesKeywords(cpp, ['(unclosed'])).toBe(false);
  });
});

describe('ranking / sorting', () => {
  it('ranks by relevance (title and tags weigh more)', () => {
    const ranked = rankResources(all, 'rust ownership', 2);
    expect(ranked[0]).toBe(rust);
    expect(rankResources(all, 'zzz nothing', 5)).toEqual([]);
  });

  it('puts an exact title before titles it is only a prefix of', () => {
    // Newest first, so without a whole-word bonus "19999" would win the createdAt tie-break.
    const library = Array.from({ length: 20_000 }, (_, i) =>
      make(`https://scale.example.com/page/${i}`, { title: `Scale page ${i}`, createdAt: i }),
    );
    const ranked = rankResources(library, 'scale page 1999', 5);
    expect(ranked[0]?.title).toBe('Scale page 1999');
    expect(ranked).toHaveLength(5);
    // A whole-word token also beats a prefix match without the exact-title bonus.
    expect(rankResources(library, 'page 1999', 1)[0]?.title).toBe('Scale page 1999');
  });

  it('reads a letter outside the basic plane as part of the word', () => {
    // U+20000 is a CJK letter written as two UTF-16 units; "abc" after it is not a whole word.
    const inside = make('https://inside.example.com', { title: '\u{20000}abc', createdAt: 2 });
    const prefix = make('https://prefix.example.com', { title: 'zz abcd', createdAt: 1 });
    expect(rankResources([inside, prefix], 'abc', 2)[0]).toBe(prefix);
  });

  it('keeps the full-sort order: score, then newer, then input order', () => {
    const same = (id: string, createdAt: number) =>
      make(`https://${id}.example.com`, { id, title: 'Rust notes', createdAt });
    const library = [
      same('a', 1),
      same('b', 3),
      same('c', 3),
      same('d', 2),
      { ...same('fav', 0), isFavorite: true },
    ];
    expect(rankResources(library, 'rust notes', 10).map((r) => r.id)).toEqual([
      'fav',
      'b',
      'c',
      'd',
      'a',
    ]);
    expect(rankResources(library, 'rust notes', 2).map((r) => r.id)).toEqual(['fav', 'b']);
    expect(rankResources(library, 'rust notes', 0)).toEqual([]);
  });

  it('gives the same results when the query is typed a token at a time', () => {
    const library = Array.from({ length: 300 }, (_, i) =>
      make(`https://site${i % 7}.example.com/${i}`, {
        title: `Item ${i} ${i % 3 === 0 ? 'rust' : 'go'}`,
        tags: i % 5 === 0 ? ['rust'] : [],
        createdAt: i % 11,
      }),
    );
    const typed = ['it', 'item', 'item 1', 'item 12', 'item 12 rust'].map((q) =>
      rankResources(library, q, 8),
    );
    // A fresh array has no cached token columns: the result must not depend on the cache.
    const fresh = ['it', 'item', 'item 1', 'item 12', 'item 12 rust'].map((q) =>
      rankResources([...library], q, 8),
    );
    expect(typed).toEqual(fresh);
  });

  it('ranks 100k records within a keystroke budget once indexed', () => {
    const library = Array.from({ length: 100_000 }, (_, i) =>
      make(`https://site${i % 500}.example.com/page/${i}`, {
        title: `Scale page ${i}`,
        tags: ['scale'],
        createdAt: i,
      }),
    );
    rankResources(library, 'scale', 8); // Warm-up: builds the index, a one-off cost the timing excludes.
    const started = performance.now();
    for (const query of ['scale p', 'scale pa', 'scale page', 'scale page 1', 'scale page 19']) {
      rankResources(library, query, 8);
    }
    const perKeystroke = (performance.now() - started) / 5;
    // Generous for slow CI machines; the point is the shape, not the exact budget.
    expect(perKeystroke).toBeLessThan(250);
    expect(rankResources(library, 'scale page 1999', 1)[0]?.title).toBe('Scale page 1999');
  }, 60_000);

  it('sorts by createdAt without mutating the input', () => {
    expect(sortByCreatedAt(all).map((r) => r.createdAt)).toEqual([3, 2, 1]);
    expect(sortByCreatedAt(all, 'asc').map((r) => r.createdAt)).toEqual([1, 2, 3]);
    expect(all[0]).toBe(istanbul);
  });

  it('visibleResources honors the active collection and search query', () => {
    const state = {
      resources: all,
      collections: [collection(['rust'])],
      scope: { collectionId: 'c1' } as const,
      searchQuery: '',
    };
    expect(visibleResources(state)).toEqual([rust]);
    expect(visibleResources({ ...state, scope: 'all', searchQuery: 'email' })).toEqual([email]);
  });
});

describe('healthSummary', () => {
  it('counts each resource in exactly one health bucket', () => {
    const summary = healthSummary([
      make('https://a.com', { health: { status: 'dead', checkedAt: 1 } }),
      make('https://b.com', { media: { challenge: true } }),
      make('https://c.com', { media: { imageUrl: 'https://c.com/og.png' } }),
      make('https://d.com'),
      make('https://e.com', { ai: { status: 'ok', analyzedAt: 1, confidence: 0.2 } }),
    ]);
    expect(summary).toMatchObject({
      total: 5,
      broken: 1,
      protected: 1,
      healthy: 1,
      missingPreview: 2,
      notAnalyzed: 4,
    });
    expect(summary.broken + summary.protected + summary.healthy + summary.missingPreview).toBe(5);
  });
});

describe('workingPercent', () => {
  it('rounds, but never to 100 with a broken link or to 0 with a working one', () => {
    expect(workingPercent(2037, 1)).toBe(99);
    expect(workingPercent(2037, 2036)).toBe(1);
    expect(workingPercent(4, 1)).toBe(75);
    expect(workingPercent(10, 0)).toBe(100);
    expect(workingPercent(10, 10)).toBe(0);
    expect(workingPercent(0, 0)).toBe(100);
  });
});

describe('membership cache', () => {
  const collection = (keywords: string[], pinnedIds: string[] = []): Collection => ({
    id: 'c1',
    name: 'Preview',
    description: '',
    keywords,
    pinnedIds,
    createdAt: 1,
    updatedAt: 1,
  });

  it('stays bounded while the rule keeps changing (keyword chips, pin toggles)', () => {
    const resource = make('https://a.com');
    for (let i = 0; i < 200; i += 1) {
      isCollectionMember(resource, collection([`k${i}`], i % 2 === 0 ? [`p${i}`] : []));
    }
    expect(cachedRuleCount(resource)).toBeLessThanOrEqual(8);
  });

  it('still answers correctly after the cache was dropped', () => {
    const resource = make('https://a.com', { title: 'Rust ownership' });
    for (let i = 0; i < 20; i += 1) isCollectionMember(resource, collection([`k${i}`]));
    expect(isCollectionMember(resource, collection(['rust']))).toBe(true);
    expect(isCollectionMember(resource, collection(['pasta']))).toBe(false);
  });
});

describe('resourceById', () => {
  it('finds a record in the array it was given, and nothing for a null or unknown id', () => {
    const a = make('https://a.com');
    const b = make('https://b.com');
    const list = [a, b];
    expect(resourceById(list, b.id)).toBe(b);
    expect(resourceById(list, null)).toBeUndefined();
    expect(resourceById(list, 'missing')).toBeUndefined();

    const renamed = { ...b, title: 'B' };
    expect(resourceById([a, renamed], b.id)).toBe(renamed);
  });
});
