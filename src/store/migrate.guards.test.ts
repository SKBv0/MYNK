import { describe, expect, it } from 'vitest';
import { CorruptLibraryError, parsePersisted } from './migrate';

const NOW = Date.UTC(2026, 8, 1);

describe('parsePersisted: damaged current files', () => {
  const v3 = (extra: Record<string, unknown> = {}) => ({
    version: 3,
    savedAt: NOW,
    resources: [{ id: 'keep', url: 'https://example.com' }],
    collections: [],
    chats: {},
    settings: {},
    healthMeta: {},
    ...extra,
  });

  it('refuses a file without a version field', () => {
    const { version: _version, ...noVersion } = v3();
    expect(() => parsePersisted(JSON.stringify(noVersion), NOW)).toThrow(CorruptLibraryError);
    expect(() =>
      parsePersisted(JSON.stringify({ resources: [], healthMeta: { hasRun: true } }), NOW),
    ).toThrow(CorruptLibraryError);
    expect(() =>
      parsePersisted(JSON.stringify({ resources: [{ id: 'a', url: 'https://example.com' }] }), NOW),
    ).toThrow(CorruptLibraryError);
  });

  it.each([
    ['collections', {}],
    ['collections', 'x'],
    ['chats', []],
    ['chats', null],
    ['settings', 'dark'],
    ['healthMeta', []],
  ])('refuses a v3 file whose %s section has the wrong type (%j)', (key, value) => {
    expect(() => parsePersisted(JSON.stringify(v3({ [key]: value })), NOW)).toThrow(
      CorruptLibraryError,
    );
  });

  it('accepts v3 files that lack optional sections', () => {
    const minimal = JSON.stringify({ version: 3, resources: [] });
    expect(parsePersisted(minimal, NOW).resources).toEqual([]);
  });
});

describe('resource ids that collide with Object.prototype', () => {
  it('parses a v3 library whose chat threads are keyed by "constructor" and "__proto__"', () => {
    const json = JSON.stringify({
      version: 3,
      savedAt: NOW,
      resources: [
        { id: 'constructor', url: 'https://example.com/a' },
        { id: '__proto__', url: 'https://example.com/b' },
      ],
      // Computed keys: a plain `__proto__:` in an object literal would set the prototype instead.
      chats: {
        ['constructor']: [{ id: 'm1', role: 'user', content: 'Q', createdAt: NOW }],
        ['__proto__']: [{ id: 'm2', role: 'user', content: 'Q2', createdAt: NOW }],
      },
    });
    const data = parsePersisted(json, NOW);
    expect(data.resources.map((r) => r.id)).toEqual(['constructor', '__proto__']);
    expect(Object.keys(data.chats).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.values(data.chats).map((list) => list.length)).toEqual([1, 1]);
  });
});
