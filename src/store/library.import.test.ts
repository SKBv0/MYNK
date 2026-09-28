import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './index';
import { nth } from '../test/assert';

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initial, true);
});

const store = () => useAppStore.getState();

describe('importBookmarks', () => {
  it('refreshes folderPath from the latest import and leaves existing tags alone', async () => {
    await store().importBookmarks([
      { url: 'https://a.example.com/', title: 'A', folderPath: ['Old'] },
    ]);
    await store().importBookmarks([
      { url: 'https://a.example.com/', title: 'A', folderPath: ['New', 'Sub'] },
    ]);
    let [resource] = store().resources;
    expect(resource?.folderPath).toEqual(['New', 'Sub']);
    expect(resource?.tags).toEqual(['old', 'new', 'sub']);

    // A root-level entry (no folder information) does not wipe the known folder.
    await store().importBookmarks([{ url: 'https://a.example.com/', title: 'A', folderPath: [] }]);
    [resource] = store().resources;
    expect(resource?.folderPath).toEqual(['New', 'Sub']);
  });

  it('uses LAST_MODIFIED (updatedAt) for new records', async () => {
    await store().importBookmarks([
      {
        url: 'https://a.example.com/',
        title: 'A',
        folderPath: [],
        addedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_500_000,
      },
    ]);
    expect(nth(store().resources, 0)).toMatchObject({
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
    });
  });

  it("keeps the file's own tags when folder tags would push them over the cap", async () => {
    const own = Array.from({ length: 24 }, (_, i) => `own-${i}`);
    await store().importBookmarks([
      { url: 'https://a.example.com/', title: 'A', folderPath: ['Dev', 'Rust'], tags: own },
    ]);
    expect(nth(store().resources, 0).tags).toEqual(own);
  });

  it('reports only the records it created, not one added while it yielded', async () => {
    const existing = store().addResource({ url: 'https://kept.example.com/' })?.resource;
    const items = Array.from({ length: 3000 }, (_, i) => ({
      url: `https://site${i}.example.com/`,
      title: `Site ${i}`,
      folderPath: [],
    }));
    items.push({ url: 'https://kept.example.com/', title: 'Kept', folderPath: [] });
    // Fires at the import's first yield, so the merge is redone against the changed list.
    setTimeout(() => store().addResource({ url: 'https://typed.example.com/' }), 0);
    let addedIds: string[] = [];

    const outcome = await store().importBookmarks(items, {
      onAdded: (ids) => {
        addedIds = ids;
      },
    });

    expect(outcome).toEqual({ added: 3000, merged: 1, unchanged: 0, skipped: 0 });
    const typed = store().resources.find((r) => r.url === 'https://typed.example.com/');
    expect(typed).toBeDefined();
    expect(addedIds).toHaveLength(3000);
    expect(addedIds).not.toContain(typed?.id);
    expect(addedIds).not.toContain(existing?.id);
  });

  it('accepts intranet hosts from files while typed URLs stay strict', async () => {
    const outcome = await store().importBookmarks([
      { url: 'http://wiki/', title: 'Wiki', folderPath: [] },
      { url: 'http://jira/browse/X-1', title: 'Ticket', folderPath: [] },
    ]);
    expect(outcome).toEqual({ added: 2, merged: 0, unchanged: 0, skipped: 0 });
    expect(store().addResource({ url: 'intranet' })).toBeNull();
  });
});

describe('no-op patches', () => {
  it('updateResource with an empty or unchanged patch keeps the record and updatedAt', () => {
    const id = store().addResource({ url: 'https://x.example.com', title: 'X' })?.resource
      .id as string;
    const before = store().resources;
    const stamp = nth(before, 0).updatedAt;

    store().updateResource(id, {});
    store().updateResource(id, { title: ' X ', tags: [], description: '', summary: [] });
    store().updateResource(id, { categoryId: 'other' });
    expect(store().resources).toBe(before);
    expect(store().resources[0]?.updatedAt).toBe(stamp);

    store().updateResource(id, { title: 'Y' });
    expect(store().resources).not.toBe(before);
    expect(store().resources[0]?.title).toBe('Y');
  });

  it('updateCollection with an empty or unchanged patch keeps the collection', () => {
    const created = store().createCollection({
      name: 'Rust',
      description: 'Lang',
      keywords: ['rust'],
    });
    const id = created?.id as string;
    const before = store().collections;

    store().updateCollection(id, {});
    store().updateCollection(id, { name: '  ', description: ' Lang ', keywords: ['RUST'] });
    expect(store().collections).toBe(before);

    store().updateCollection(id, { keywords: ['rust', 'wasm'] });
    expect(store().collections).not.toBe(before);
    expect(store().collections[0]?.keywords).toEqual(['rust', 'wasm']);
  });
});
