import { describe, expect, it } from 'vitest';
import { BackupError, encodeNetscapeTag, parseBackup, toNetscapeHtml } from './export';
import { createResource } from '../store/model';
import { decodeNetscapeTag, parseNetscapeHtml } from '../services/bookmarkParser';
import type { Resource } from '../types';

const NOW = Date.UTC(2026, 8, 1);

const make = (url: string, patch: Partial<Resource> = {}): Resource => {
  const resource = createResource({ url }, 1_700_000_000_000);
  if (!resource) throw new Error(`bad url ${url}`);
  return { ...resource, ...patch };
};

describe('Netscape export: TAGS and LAST_MODIFIED round-trip', () => {
  it('keeps a comma (and a percent sign) inside a tag', async () => {
    const html = toNetscapeHtml([
      make('https://a.example.com/', { tags: ['c, c++', '100%', 'rust'] }),
    ]);
    expect(html).toContain('TAGS="c%2C c++,100%25,rust"');
    const [item] = await parseNetscapeHtml(html);
    expect(item?.tags).toEqual(['c, c++', '100%', 'rust']);
  });

  it('encodeNetscapeTag and decodeNetscapeTag are inverse', () => {
    for (const tag of ['a,b', '%2C', '100%', '%25,%', 'plain', 'ı,İ']) {
      expect(decodeNetscapeTag(encodeNetscapeTag(tag))).toBe(tag);
      expect(encodeNetscapeTag(tag)).not.toContain(',');
    }
  });

  it('reads LAST_MODIFIED back as updatedAt', async () => {
    const html = toNetscapeHtml([
      make('https://a.example.com/', {
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_900_000,
      }),
    ]);
    const [item] = await parseNetscapeHtml(html);
    expect(item?.addedAt).toBe(1_700_000_000_000);
    expect(item?.updatedAt).toBe(1_700_000_900_000);
  });
});

describe('parseBackup versions', () => {
  it('rejects a missing or malformed version instead of guessing', () => {
    const code = (json: string) => {
      try {
        parseBackup(json, NOW);
      } catch (error) {
        return error instanceof BackupError ? error.code : 'other';
      }
      return 'none';
    };
    expect(code('{"app":"mynk","resources":[]}')).toBe('invalidVersion');
    expect(code('{"app":"mynk","version":"3","resources":[]}')).toBe('invalidVersion');
    expect(code('{"app":"mynk","version":0,"resources":[]}')).toBe('invalidVersion');
    expect(code('{"app":"mynk","version":2.5,"resources":[]}')).toBe('invalidVersion');
    expect(code('{"app":"mynk","version":4,"resources":[]}')).toBe('unsupportedVersion');
    expect(code('{"app":"mynk","version":2,"resources":[]}')).toBe('oldVersion');
    expect(code('{"app":"mynk","version":3,"resources":[]}')).toBe('none');
  });
});
