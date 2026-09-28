/**
 * A 100 000-bookmark import must not freeze the window: the work runs in slices that yield to
 * the browser, and the library is still updated with one `set` (one disk write).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './index';
import { IMPORT_CHUNK_SIZE } from './slices/library';
import type { ImportedBookmark } from '../services/ipcTypes';

const initial = useAppStore.getState();
const store = () => useAppStore.getState();

const bookmarks = (count: number, offset = 0): ImportedBookmark[] =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://site-${(i + offset) % 3000}.example.com/page/${i + offset}?utm_source=x&b=2&a=1`,
    title: `Page ${i + offset}`,
    folderPath: ['Bookmarks bar', `Folder ${(i + offset) % 50}`, `Sub ${(i + offset) % 7}`],
    addedAt: 1_600_000_000_000 + i,
  }));

type SchedulerStub = { scheduler?: { yield: () => Promise<void> } };

/** Replaces `scheduler.yield` and counts how often the import handed the main thread back. */
const watchSlices = () => {
  const watch = { yields: 0 };
  (globalThis as SchedulerStub).scheduler = {
    yield: () => {
      watch.yields += 1;
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
  return watch;
};

beforeEach(() => {
  useAppStore.setState(initial, true);
});

afterEach(() => {
  delete (globalThis as { scheduler?: unknown }).scheduler;
});

describe('importing 100 000 bookmarks', () => {
  it('yields between slices and updates the library once', async () => {
    await store().importBookmarks(bookmarks(50_000));
    let sets = 0;
    const stop = useAppStore.subscribe((next, prev) => {
      if (next.resources !== prev.resources) sets += 1;
    });
    const watch = watchSlices();

    // 25 000 of these are already in the library.
    const outcome = await store().importBookmarks(bookmarks(100_000, 25_000));
    stop();

    expect(outcome).toEqual({ added: 75_000, merged: 25_000, unchanged: 0, skipped: 0 });
    expect(store().resources).toHaveLength(125_000);
    expect(sets).toBe(1);
    // Two passes (build, merge) over 100 000 items in slices of IMPORT_CHUNK_SIZE.
    expect(watch.yields).toBeGreaterThanOrEqual((2 * 100_000) / IMPORT_CHUNK_SIZE - 2);
  }, 60_000);

  it('does not lose a change made to the library while the import yields', async () => {
    let yields = 0;
    (globalThis as SchedulerStub).scheduler = {
      yield: () => {
        yields += 1;
        // Yields 1-2 build the records, 3+ merge; this change must survive the final `set`.
        if (yields === 3) {
          store().addResource({ url: 'https://added-meanwhile.example.com/' });
        }
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    };

    const count = IMPORT_CHUNK_SIZE * 2 + 10;
    const outcome = await store().importBookmarks(bookmarks(count));

    expect(outcome.added).toBe(count);
    expect(store().resources.map((r) => r.url)).toContain('https://added-meanwhile.example.com/');
    expect(store().resources).toHaveLength(count + 1);
  }, 30_000);
});
