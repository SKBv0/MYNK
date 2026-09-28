/** Deterministic domain fixtures. Ids and dates are explicit so assertions never race the clock. */
import type { Collection, Resource } from '../types';
import { canonicalUrlKey } from '../lib/url';

/** 2026-03-15T12:00:00Z: a fixed "now" for date-dependent assertions. */
export const NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

export interface ResourceOverrides extends Partial<Omit<Resource, 'url' | 'urlKey'>> {
  url?: string;
}

let seq = 0;

/** A complete, valid Resource. Only what the test cares about needs to be passed. */
export const makeResource = (overrides: ResourceOverrides = {}): Resource => {
  seq += 1;
  const url = overrides.url ?? `https://example-${seq}.com/page`;
  return {
    id: `r${seq}`,
    url,
    urlKey: canonicalUrlKey(url),
    title: `Resource ${seq}`,
    description: '',
    categoryId: 'other',
    tags: [],
    summary: [],
    folderPath: [],
    createdAt: NOW - seq * 60_000,
    updatedAt: NOW - seq * 60_000,
    lastOpenedAt: null,
    isFavorite: false,
    ai: { status: 'none', analyzedAt: null, confidence: null },
    media: {},
    health: { status: 'unknown', checkedAt: null },
    ...overrides,
  };
};

export const makeCollection = (overrides: Partial<Collection> = {}): Collection => {
  seq += 1;
  return {
    id: `c${seq}`,
    name: `Collection ${seq}`,
    description: '',
    keywords: [],
    pinnedIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
};

/** A small Netscape bookmark export with nested folders, ADD_DATE and one unusable entry. */
export const NETSCAPE_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://rust-lang.org/" ADD_DATE="1700000100">Rust</A>
        <DT><H3 ADD_DATE="1700000200">Dev</H3>
        <DL><p>
            <DT><A HREF="https://tokio.rs/" ADD_DATE="1700000300">Tokio</A>
            <DT><A HREF="javascript:void(0)" ADD_DATE="1700000400">Broken entry</A>
            <DT><A ADD_DATE="1700000500">No href at all</A>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://react.dev/" ADD_DATE="1700000600">React</A>
    </DL><p>
</DL><p>
`;

/** A Chromium `Bookmarks` JSON file (WebKit microseconds since 1601). */
export const CHROME_JSON = JSON.stringify({
  roots: {
    bookmark_bar: {
      name: 'Bookmarks bar',
      type: 'folder',
      children: [
        {
          type: 'url',
          name: 'Vite',
          url: 'https://vite.dev/',
          // 2023-11-14T22:13:20Z in WebKit microseconds.
          date_added: String((1700000000000 + 11_644_473_600_000) * 1000),
        },
        {
          type: 'folder',
          name: 'Tooling',
          children: [
            { type: 'url', name: 'Vitest', url: 'https://vitest.dev/', date_added: '0' },
            { type: 'url', name: 'Not a link', url: 'chrome://bookmarks' },
          ],
        },
      ],
    },
  },
});
