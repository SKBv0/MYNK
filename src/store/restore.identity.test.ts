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

const collection = (id: string, pinnedIds: string[]): Collection => ({
  id,
  name: `C ${id}`,
  description: '',
  keywords: [],
  pinnedIds,
  createdAt: 1,
  updatedAt: 1,
});

describe('mergeLibraryData: the current record keeps its identity', () => {
  it('keeps the current id and media when the backup copy is older', () => {
    const current = make('https://react.dev/', {
      createdAt: Date.UTC(2024, 0, 1),
      media: { snapshotFile: 'snap-current.png', uploadedFile: 'upload-current.png' },
    });
    const older = make('https://www.react.dev', {
      createdAt: Date.UTC(2019, 0, 1),
      media: { snapshotFile: 'snap-old.png', faviconUrl: 'https://react.dev/favicon.ico' },
    });
    const backup: ParsedBackup = {
      resources: [older],
      collections: [collection('c-backup', [older.id])],
      chats: { [older.id]: [{ id: 'm1', role: 'user', content: 'Q', createdAt: 5 }] },
      exportedAt: null,
    };

    const { data, outcome } = mergeLibraryData(
      { resources: [current], collections: [], chats: {} },
      backup,
      'merge',
    );

    expect(data.resources).toHaveLength(1);
    const [merged] = data.resources;
    expect(merged?.id).toBe(current.id);
    expect(merged?.createdAt).toBe(Date.UTC(2019, 0, 1));
    expect(merged?.media).toEqual({
      snapshotFile: 'snap-current.png',
      uploadedFile: 'upload-current.png',
      faviconUrl: 'https://react.dev/favicon.ico',
    });
    // References from the backup follow the surviving (current) id.
    expect(data.collections[0]?.pinnedIds).toEqual([current.id]);
    expect(data.chats[current.id]?.map((m) => m.id)).toEqual(['m1']);
    expect(outcome).toMatchObject({ added: 0, merged: 1 });
  });

  it("never carries the backup copy's file names into the current record", () => {
    const current = make('https://vitejs.dev/', {
      createdAt: Date.UTC(2024, 0, 1),
      media: { faviconUrl: 'https://vitejs.dev/logo.svg' },
    });
    const older = make('https://vitejs.dev', {
      createdAt: Date.UTC(2020, 0, 1),
      media: {
        uploadedFile: 'upload-gone.png',
        snapshotFile: 'snap-gone.png',
        imageUrl: 'https://vitejs.dev/og.png',
        previewBlocked: true,
      },
    });

    const { data } = mergeLibraryData(
      { resources: [current], collections: [], chats: {} },
      { resources: [older], collections: [], chats: {}, exportedAt: null },
      'merge',
    );

    expect(data.resources[0]?.media).toEqual({
      faviconUrl: 'https://vitejs.dev/logo.svg',
      imageUrl: 'https://vitejs.dev/og.png',
      previewBlocked: true,
    });
  });
});
