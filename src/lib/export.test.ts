import { describe, expect, it } from 'vitest';
import {
  BackupError,
  backupToJson,
  escapeHtml,
  exportFileName,
  parseBackup,
  toNetscapeHtml,
} from './export';
import { createResource } from '../store/model';
import { mergeLibraryData } from '../store/restore';
import { parseNetscapeHtml } from '../services/bookmarkParser';
import type { Collection, Resource } from '../types';
import { nth } from '../test/assert';

const make = (url: string, patch: Partial<Resource> = {}): Resource => {
  const resource = createResource({ url }, 1_700_000_000_000);
  if (!resource) throw new Error(`bad url ${url}`);
  return { ...resource, ...patch };
};

const collection = (id: string, pinnedIds: string[] = []): Collection => ({
  id,
  name: `C ${id}`,
  description: '',
  keywords: ['rust'],
  pinnedIds,
  createdAt: 1,
  updatedAt: 1,
});

describe('export', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;',
    );
  });

  it('builds a Netscape file with folders, second-based ADD_DATE and escaped text', () => {
    const html = toNetscapeHtml([
      make('https://react.dev', {
        title: 'React <docs>',
        folderPath: ['Dev', 'JS'],
        tags: ['react', 'ui'],
        createdAt: 1_700_000_000_000,
      }),
      make('https://example.com', { title: 'Root & co', folderPath: [] }),
    ]);
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('<H3 ADD_DATE="1700000000"');
    expect(html).toContain('>Dev</H3>');
    expect(html).toContain('ADD_DATE="1700000000"');
    expect(html).toContain('TAGS="react,ui"');
    expect(html).toContain('>React &lt;docs&gt;</A>');
    expect(html).toContain('>Root &amp; co</A>');
  });

  it('round-trips through the bookmark importer', async () => {
    const html = toNetscapeHtml([
      make('https://react.dev/', { title: 'React', folderPath: ['Dev', 'JS'] }),
      make('https://rust-lang.org/', { title: 'Rust', folderPath: ['Dev'] }),
      make('https://example.com/', { title: 'Example', folderPath: [] }),
    ]);
    const imported = await parseNetscapeHtml(html);
    const byTitle = new Map(imported.map((item) => [item.title, item]));
    expect(byTitle.get('React')?.folderPath).toEqual(['Dev', 'JS']);
    expect(byTitle.get('Rust')?.folderPath).toEqual(['Dev']);
    expect(byTitle.get('Example')?.url).toBe('https://example.com/');
    expect(byTitle.get('React')?.addedAt).toBe(1_700_000_000_000);
  });

  it('keeps AI tags and description on an HTML round-trip', async () => {
    const html = toNetscapeHtml([
      make('https://react.dev/', {
        title: 'React',
        tags: ['ui', 'javascript', 'frontend'],
        description: 'A library for building user interfaces.',
        folderPath: ['Dev'],
      }),
    ]);
    const [imported] = await parseNetscapeHtml(html);
    expect(imported?.tags).toEqual(['ui', 'javascript', 'frontend']);
    expect(imported?.description).toBe('A library for building user interfaces.');
    expect(imported?.folderPath).toEqual(['Dev']);
  });

  it('JSON backup has the documented envelope and parses back', () => {
    const resources = [make('https://react.dev'), make('https://rust-lang.org')];
    const json = backupToJson(
      { resources, collections: [collection('c1', [nth(resources, 1).id])], chats: {} },
      new Date('2026-09-11T10:00:00Z'),
    );
    const raw = JSON.parse(json) as Record<string, unknown>;
    expect(raw.app).toBe('mynk');
    expect(raw.version).toBe(3);
    expect(raw.exportedAt).toBe('2026-09-11T10:00:00.000Z');
    expect(raw.chats).toBeUndefined();
    const parsed = parseBackup(json);
    expect(parsed.resources).toHaveLength(2);
    expect(parsed.collections[0]?.pinnedIds).toEqual([resources[1]?.id]);
  });

  it('rejects foreign or broken files', () => {
    expect(() => parseBackup('{nope')).toThrow(BackupError);
    expect(() => parseBackup('{"resources": []}')).toThrow(/notMynk/);
    expect(() => parseBackup('{"app":"mynk","version":99,"resources":[]}')).toThrow(
      /unsupportedVersion/,
    );
  });

  it('names files by date', () => {
    expect(exportFileName('json', new Date(2026, 8, 1))).toBe('mynk-2026-09-01.json');
    expect(exportFileName('html', new Date(2026, 8, 1))).toBe('mynk-2026-09-01.html');
  });
});

describe('restore', () => {
  it('merge keeps current records and merges duplicates by canonical URL', () => {
    const current = [make('https://react.dev', { isFavorite: true })];
    const backup = parseBackup(
      backupToJson({
        resources: [make('https://www.react.dev/'), make('https://rust-lang.org')],
        collections: [collection('c9')],
      }),
    );
    const { data, outcome } = mergeLibraryData(
      { resources: current, collections: [collection('c1')], chats: {} },
      backup,
      'merge',
    );
    expect(data.resources).toHaveLength(2);
    expect(data.resources.find((r) => r.urlKey === current[0]?.urlKey)?.isFavorite).toBe(true);
    expect(data.collections.map((c) => c.id)).toEqual(['c1', 'c9']);
    expect(outcome).toMatchObject({ added: 1, merged: 1, collections: 1 });
  });

  it('replace swaps the library data', () => {
    const backup = parseBackup(
      backupToJson({ resources: [make('https://a.com')], collections: [] }),
    );
    const { data } = mergeLibraryData(
      { resources: [make('https://b.com')], collections: [collection('c1')], chats: {} },
      backup,
      'replace',
    );
    expect(data.resources.map((r) => r.url)).toEqual(['https://a.com/']);
    expect(data.collections).toEqual([]);
  });
});
