import { describe, expect, it } from 'vitest';
import { PERSIST_VERSION, normalizePersisted, parsePersisted } from './migrate';

const NOW = Date.UTC(2026, 8, 1);

const v3With = (media: Record<string, unknown>) => ({
  version: PERSIST_VERSION,
  resources: [{ id: 'r1', url: 'https://example.com/', media }],
});

describe('v3 media fields (remote media cache)', () => {
  it('keeps cached file names and the cache timestamp', () => {
    const data = normalizePersisted(
      v3With({
        faviconUrl: 'https://example.com/favicon.ico',
        imageUrl: 'https://example.com/og.png',
        faviconFile: 'fav-0123abcd.ico',
        imageFile: 'img-0123abcd.webp',
        remoteCachedAt: NOW - 5,
      }),
      NOW,
    );
    expect(data.resources[0]?.media).toEqual({
      faviconUrl: 'https://example.com/favicon.ico',
      imageUrl: 'https://example.com/og.png',
      faviconFile: 'fav-0123abcd.ico',
      imageFile: 'img-0123abcd.webp',
      remoteCachedAt: NOW - 5,
    });
  });

  it('drops unsafe file names and invalid timestamps', () => {
    const data = normalizePersisted(
      v3With({
        faviconFile: '../../secret.ico',
        imageFile: 'C:\\Windows\\win.ini',
        remoteCachedAt: 'yesterday',
      }),
      NOW,
    );
    expect(data.resources[0]?.media).toEqual({});
  });

  it('v3 payloads without the media cache fields stay valid (no version bump needed)', () => {
    const json = JSON.stringify(
      v3With({ faviconUrl: 'https://example.com/favicon.ico', snapshotFile: 'abc.png' }),
    );
    const parsed = parsePersisted(json, NOW);
    expect(parsed.version).toBe(3);
    expect(parsed.resources[0]?.media).toEqual({
      faviconUrl: 'https://example.com/favicon.ico',
      snapshotFile: 'abc.png',
    });
  });
});
