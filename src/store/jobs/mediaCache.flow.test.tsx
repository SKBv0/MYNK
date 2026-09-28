import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { deferred, mockRust, stopRust, type RustMock } from '../../test/ipc';
import { flush, renderApp, resetApp, seedLibrary, store } from '../../test/app';
import { makeResource } from '../../test/fixtures';
import { deleteResourcesWithMedia } from './preview';

let rust: RustMock;

const A = 'https://a.example.com/';
const FAVICON = 'https://a.example.com/favicon.ico';
const OG = 'https://a.example.com/og.png';

const mediaOf = (url: string) => store().resources.find((r) => r.url === url)?.media;

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('start-up media handling', () => {
  it('caches the remote images of existing records exactly once', async () => {
    rust.on('cache_remote_image', (args) => (args.kind === 'favicon' ? 'fav-1.png' : 'og-1.png'));
    seedLibrary([makeResource({ url: A, media: { faviconUrl: FAVICON, imageUrl: OG } })]);
    await renderApp();

    await waitFor(() => expect(mediaOf(A)?.imageFile).toBe('og-1.png'));
    expect(mediaOf(A)?.faviconFile).toBe('fav-1.png');
    expect(mediaOf(A)?.remoteCachedAt).toBeGreaterThan(0);
    expect(rust.countOf('cache_remote_image')).toBe(2);
    // The remote URLs stay as provenance but are never rendered directly.
    expect(mediaOf(A)?.faviconUrl).toBe(FAVICON);
  });

  it('records the attempt even when the download fails, so it is not retried on every start', async () => {
    rust.on('cache_remote_image', () => {
      throw { kind: 'network', message: 'unreachable' };
    });
    seedLibrary([makeResource({ url: A, media: { faviconUrl: FAVICON } })]);
    await renderApp();

    await waitFor(() => expect(mediaOf(A)?.remoteCachedAt).toBeGreaterThan(0));
    expect(mediaOf(A)?.faviconFile).toBeUndefined();
    // A failed cache is silent: the generated artwork is shown instead.
    expect(store().toasts).toHaveLength(0);
  });

  it('hands the maintenance the files that are still referenced', async () => {
    seedLibrary([
      makeResource({ url: A, media: { snapshotFile: 'keep-1.png', faviconFile: 'keep-2.png' } }),
    ]);
    await renderApp();

    await waitFor(() => expect(rust.countOf('maintain_snapshots')).toBe(1));
    expect(rust.argsOf('maintain_snapshots')[0]?.keepFileNames).toEqual([
      'keep-1.png',
      'keep-2.png',
    ]);
    expect(store().mediaReady).toBe(true);
  });

  it('drops references to files the maintenance had to evict', async () => {
    rust.on('maintain_snapshots', () => ({
      deletedUnreferenced: 3,
      evicted: ['gone.png'],
      totalBytes: 1024,
    }));
    seedLibrary([
      makeResource({ url: A, title: 'Evicted', media: { snapshotFile: 'gone.png' } }),
      makeResource({ url: 'https://b.example.com/', media: { snapshotFile: 'kept.png' } }),
    ]);
    await renderApp();

    await waitFor(() => expect(mediaOf(A)?.snapshotFile).toBeUndefined());
    expect(mediaOf('https://b.example.com/')?.snapshotFile).toBe('kept.png');
    expect(store().snapshotCacheBytes).toBe(1024);
    // The card falls back to its generated cover instead of a broken image.
    expect(await screen.findByText('Evicted')).toBeInTheDocument();
  });

  it('keeps working when the snapshot directory cannot be prepared', async () => {
    rust.on('get_snapshot_dir', () => {
      throw { kind: 'storage', message: 'no cache dir' };
    });
    seedLibrary([makeResource({ url: A, title: 'Still here' })]);
    await renderApp();

    expect(await screen.findByText('Still here')).toBeInTheDocument();
    await waitFor(() => expect(store().toasts.length).toBeGreaterThan(0));
    expect(store().mediaReady).toBe(false);
    expect(rust.countOf('maintain_snapshots')).toBe(0);
  });
});

describe('deleting records while media patches are pending', () => {
  it('keeps a shared cached file that only a not-yet-flushed patch references', async () => {
    const B = 'https://b.example.com/';
    const C = 'https://c.example.com/';
    // C's download stays open, so the queue is not idle and B's patch is not flushed early.
    const slow = deferred<string>();
    rust.on('cache_remote_image', (args) =>
      String(args.url).startsWith(C) ? slow.promise : 'shared.ico',
    );
    seedLibrary([
      // Already cached: not a backfill target.
      makeResource({ url: A, media: { faviconFile: 'shared.ico', remoteCachedAt: 1 } }),
      // Backfilled at start-up; the download resolves to the same cached file.
      makeResource({ url: B, media: { faviconUrl: 'https://b.example.com/favicon.ico' } }),
      makeResource({ url: C, media: { faviconUrl: 'https://c.example.com/favicon.ico' } }),
    ]);
    await renderApp();

    await waitFor(() => expect(rust.countOf('cache_remote_image')).toBe(2));
    await flush();
    // The patch is batched (300 ms) and has not reached the store yet.
    expect(mediaOf(B)?.faviconFile).toBeUndefined();

    const first = store().resources.find((r) => r.url === A);
    deleteResourcesWithMedia([first?.id ?? '']);
    await flush();

    expect(rust.countOf('delete_snapshots')).toBe(0);
    expect(mediaOf(B)?.faviconFile).toBe('shared.ico');
    slow.resolve('c.ico');
    await waitFor(() => expect(mediaOf(C)?.faviconFile).toBe('c.ico'));
  });
});
