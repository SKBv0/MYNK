import { describe, expect, it } from 'vitest';
import { mergeLibraryData } from './restore';
import { createResource } from './model';
import type { ParsedBackup } from '../lib/export';
import type { Collection, Resource } from '../types';

const make = (url: string, patch: Partial<Resource> = {}): Resource => {
  const resource = createResource({ url }, 1_700_000_000_000);
  if (!resource) throw new Error(`bad url ${url}`);
  return { ...resource, ...patch };
};

const collection = (id: string, patch: Partial<Collection> = {}): Collection => ({
  id,
  name: `C ${id}`,
  description: '',
  keywords: [],
  pinnedIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const backupOf = (resources: Resource[], collections: Collection[]): ParsedBackup => ({
  resources,
  collections,
  chats: {},
  exportedAt: '2026-09-01T00:00:00.000Z',
});

describe('mergeLibraryData (merge mode)', () => {
  it('merges a collection that exists on both sides instead of dropping the backup copy', () => {
    const pinned = make('https://react.dev');
    const current = {
      resources: [pinned],
      collections: [collection('c1', { keywords: ['react'] })],
      chats: {},
    };
    const backup = backupOf(
      [pinned],
      [collection('c1', { keywords: ['rust'], pinnedIds: [pinned.id], updatedAt: 99 })],
    );

    const { data, outcome } = mergeLibraryData(current, backup, 'merge');

    expect(data.collections).toHaveLength(1);
    expect(data.collections[0]?.keywords).toEqual(['react', 'rust']);
    expect(data.collections[0]?.pinnedIds).toEqual([pinned.id]);
    expect(data.collections[0]?.updatedAt).toBe(99);
    // Nothing new was added, but the existing collection did change.
    expect(outcome).toMatchObject({ collections: 0, collectionsMerged: 1 });
  });

  it('leaves an identical collection untouched and reports it as unchanged', () => {
    const same = collection('c1', { keywords: ['react'] });
    const { data, outcome } = mergeLibraryData(
      { resources: [], collections: [same], chats: {} },
      backupOf([], [{ ...same, name: 'renamed elsewhere' }]),
      'merge',
    );
    expect(data.collections[0]).toEqual(same);
    expect(outcome).toMatchObject({ collections: 0, collectionsMerged: 0 });
  });

  it('counts added bookmarks by canonical URL, not by the length delta', () => {
    const current = { resources: [make('https://react.dev')], collections: [], chats: {} };
    // The backup holds the same link twice plus one new one.
    const backup = backupOf(
      [
        make('https://www.react.dev/'),
        make('https://rust-lang.org'),
        make('https://rust-lang.org'),
      ],
      [],
    );

    const { data, outcome } = mergeLibraryData(current, backup, 'merge');

    expect(data.resources).toHaveLength(2);
    expect(outcome).toMatchObject({ resources: 3, added: 1, merged: 2 });
  });
});
