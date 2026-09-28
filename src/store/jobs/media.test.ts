import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { createResource } from '../model';
import { useAppStore } from '../index';
import type { Resource, ResourceMedia } from '../../types';
import {
  HostGate,
  cancelMediaCache,
  clearMediaReferences,
  mediaBackfillTargets,
  mediaPatchFor,
  queueMediaCache,
  resetMediaCacheForTests,
} from './media';
import { nth } from '../../test/assert';
import { stopRust } from '../../test/ipc';

const resource = (url: string, media: ResourceMedia): Resource => {
  const r = createResource({ url });
  if (!r) throw new Error('fixture');
  return { ...r, media };
};

afterEach(() => {
  resetMediaCacheForTests();
  stopRust();
  useAppStore.setState({ resources: [] });
});

describe('HostGate', () => {
  it('runs one task per host at a time, other hosts in parallel', async () => {
    const gate = new HostGate(1);
    const order: string[] = [];
    const releaseA1 = await gate.acquire('a.com');
    const b = await gate.acquire('b.com');
    let a2Started = false;
    const a2 = gate.acquire('a.com').then((release) => {
      a2Started = true;
      order.push('a2');
      return release;
    });
    await Promise.resolve();
    expect(a2Started).toBe(false);
    order.push('a1-done');
    releaseA1();
    const releaseA2 = await a2;
    expect(order).toEqual(['a1-done', 'a2']);
    releaseA2();
    b();
    // Released slots can be acquired again immediately.
    const again = await gate.acquire('a.com');
    again();
  });
});

describe('mediaPatchFor', () => {
  it('applies only URLs that are still current and stamps the attempt', () => {
    const media: ResourceMedia = {
      faviconUrl: 'https://e.com/f.ico',
      imageUrl: 'https://e.com/new.png',
    };
    const patch = mediaPatchFor(
      media,
      {
        faviconUrl: 'https://e.com/f.ico',
        faviconFile: 'fav-1.ico',
        imageUrl: 'https://e.com/old.png',
        imageFile: 'img-old.png',
      },
      42,
    );
    expect(patch).toEqual({ faviconFile: 'fav-1.ico', remoteCachedAt: 42 });
  });

  it('records failures as a removed file so stale copies disappear', () => {
    const patch = mediaPatchFor(
      { imageUrl: 'https://e.com/o.png', imageFile: 'img-stale.png' },
      { imageUrl: 'https://e.com/o.png', imageFile: undefined },
      7,
    );
    expect(patch).toEqual({ imageFile: undefined, remoteCachedAt: 7 });
    expect(mediaPatchFor({}, {}, 1)).toBeNull();
  });
});

describe('media cache queue', () => {
  it('backfill targets only records with uncached, never-attempted remote media', () => {
    const list = [
      resource('https://a.com', { faviconUrl: 'https://a.com/favicon.ico' }),
      resource('https://b.com', { faviconUrl: 'https://b.com/f.ico', faviconFile: 'fav-b.ico' }),
      resource('https://c.com', { imageUrl: 'https://c.com/o.png', remoteCachedAt: 1 }),
      resource('https://d.com', {}),
    ];
    expect(mediaBackfillTargets(list)).toEqual([list[0]?.id]);
  });

  it('caches favicon and og:image through IPC and writes file names to the store', async () => {
    const calls: { url: string; kind: string }[] = [];
    mockIPC((cmd, args) => {
      if (cmd !== 'cache_remote_image') throw new Error(`unexpected ${cmd}`);
      const { url, kind } = args as { url: string; kind: string };
      calls.push({ url, kind });
      if (url.endsWith('broken.png')) {
        return Promise.reject({ kind: 'parse', message: 'not an image' });
      }
      return kind === 'favicon' ? 'fav-a.ico' : 'img-a.png';
    });
    const a = resource('https://a.com', {
      faviconUrl: 'https://a.com/favicon.ico',
      imageUrl: 'https://a.com/og.png',
    });
    const b = resource('https://b.com', { imageUrl: 'https://b.com/broken.png' });
    useAppStore.setState({ resources: [a, b] });

    await queueMediaCache([a.id, b.id]);

    const [ra, rb] = useAppStore.getState().resources;
    expect(ra?.media.faviconFile).toBe('fav-a.ico');
    expect(ra?.media.imageFile).toBe('img-a.png');
    expect(typeof ra?.media.remoteCachedAt).toBe('number');
    expect(ra?.updatedAt).toBe(a.updatedAt);
    expect(rb?.media.imageFile).toBeUndefined();
    expect(typeof rb?.media.remoteCachedAt).toBe('number');
    expect(calls).toHaveLength(3);
  });

  it('stops downloading and ignores what still arrives after a cancel', async () => {
    let started = 0;
    let release!: (fileName: string) => void;
    const first = new Promise<string>((resolve) => {
      release = resolve;
    });
    mockIPC((cmd) => {
      if (cmd !== 'cache_remote_image') throw new Error(`unexpected ${cmd}`);
      started += 1;
      // Only the first download is held open; it is the one that is in flight on cancel.
      return started === 1 ? first : 'later.ico';
    });
    const a = resource('https://a.com', {
      faviconUrl: 'https://a.com/favicon.ico',
      imageUrl: 'https://a.com/og.png',
    });
    useAppStore.setState({ resources: [a] });

    const run = queueMediaCache([a.id]);
    await Promise.resolve();
    cancelMediaCache();
    release('fav-a.ico');
    await run;

    // The og:image was never requested, and the favicon that still came back was dropped.
    expect(started).toBe(1);
    const media = nth(useAppStore.getState().resources, 0).media;
    expect(media.faviconFile).toBeUndefined();
    expect(media.remoteCachedAt).toBeUndefined();
  });
});

describe('media patch flush', () => {
  it('keeps the same resources array when a flush changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(42);
    try {
      mockIPC(() => 'fav-a.ico');
      const a = resource('https://a.com', {
        faviconUrl: 'https://a.com/favicon.ico',
        faviconFile: 'fav-a.ico',
        remoteCachedAt: 42,
      });
      useAppStore.setState({ resources: [a] });
      const before = useAppStore.getState().resources;
      let notified = 0;
      const unsubscribe = useAppStore.subscribe(() => {
        notified += 1;
      });

      // Same file, same timestamp: the patch is a no-op.
      await queueMediaCache([a.id]);
      unsubscribe();

      expect(useAppStore.getState().resources).toBe(before);
      expect(notified).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces only the records whose media changed', () => {
    const a = resource('https://a.com', { snapshotFile: 'gone.png' });
    const b = resource('https://b.com', { snapshotFile: 'kept.png' });
    useAppStore.setState({ resources: [a, b] });

    clearMediaReferences(['gone.png']);

    const [ra, rb] = useAppStore.getState().resources;
    expect(ra?.media.snapshotFile).toBeUndefined();
    expect(rb).toBe(b);
  });
});
