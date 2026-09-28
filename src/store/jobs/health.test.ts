import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, ipcReject, mockRust, stopRust, type RustMock } from '../../test/ipc';
import type { LinkHealthResult } from '../../services/ipcTypes';
import { createResource } from '../model';
import { useAppStore } from '../index';
import {
  cancelHealthScan,
  chunkRunId,
  HEALTH_CHUNK_SIZE,
  healthChunks,
  pickFreeHostChunk,
  resetHealthScanForTests,
  scanDone,
  startHealthScan,
} from './health';

describe('health scan progress (per-call semantics)', () => {
  it('gives every chunk call its own run id', () => {
    expect(chunkRunId('scan', 0)).toBe('scan:0');
    expect(chunkRunId('scan', 3)).not.toBe(chunkRunId('scan', 2));
  });

  it('adds settled chunks to the progress of every running chunk', () => {
    // 450 URLs in chunks of 50; 200 settled, two chunks running.
    const running = [
      { processed: 20, size: 50 },
      { processed: 30, size: 50 },
    ];
    expect(scanDone(450, 200, running)).toBe(250);
    // A progress value can never exceed its own chunk.
    expect(scanDone(450, 400, [{ processed: 999, size: 50 }])).toBe(450);
    expect(scanDone(450, 400, [])).toBe(400);
    expect(scanDone(450, 0, [{ processed: -3, size: 50 }])).toBe(0);
  });

  it('keeps one host’s URLs in as few chunks as possible', () => {
    const urls = ['https://a.com/1', 'https://b.com/1', 'https://a.com/2', 'https://b.com/2'];
    expect(healthChunks(urls, 2)).toEqual([
      ['https://a.com/1', 'https://a.com/2'],
      ['https://b.com/1', 'https://b.com/2'],
    ]);
  });
});

describe('health chunk picking', () => {
  it('prefers a chunk on idle hosts, then the one with the most URLs on idle hosts', () => {
    const hosts = [['a.com', 'a.com'], ['a.com', 'b.com', 'b.com'], ['c.com']];
    const busyA = new Map([['a.com', 1]]);
    expect(pickFreeHostChunk([1, 2], hosts, busyA)).toBe(1);
    // Only chunks touching a.com are left: the mixed one still moves b.com along.
    expect(pickFreeHostChunk([0, 1], hosts, busyA)).toBe(1);
    expect(pickFreeHostChunk([0, 2], hosts, new Map())).toBe(0);
  });
});

describe('health scan run', () => {
  const PRISTINE = useAppStore.getState();
  let rust: RustMock;

  const seed = (urls: string[]) => {
    const resources = urls.map((url) => {
      const resource = createResource({ url });
      if (!resource) throw new Error('fixture');
      return resource;
    });
    useAppStore.setState({ resources });
  };

  const toasts = () => useAppStore.getState().toasts.map((t) => t.message);

  beforeEach(() => {
    useAppStore.setState(PRISTINE, true);
    rust = mockRust();
  });

  afterEach(() => {
    resetHealthScanForTests();
    stopRust();
  });

  it('reports a failed chunk as failed instead of completed', async () => {
    rust.on('check_links_health', () => ipcReject('internal', 'the scan blew up'));
    seed(['https://a.com', 'https://b.com']);

    await startHealthScan();

    const job = useAppStore.getState().jobs.health;
    expect(job).toMatchObject({ state: 'done', total: 2, failed: 2 });
    // Settled, so the bar is not stuck, but nothing was checked.
    expect(job?.done).toBe(2);
    expect(useAppStore.getState().healthMeta).toEqual({ hasRun: false, lastScanAt: null });
  });

  it('counts only the URLs of chunks that came back', async () => {
    const results: LinkHealthResult[] = [
      {
        url: 'https://a.com/',
        ok: true,
        definitelyBroken: false,
        previewBlocked: false,
        errorKind: 'none',
        status: 200,
      },
    ];
    rust.on('check_links_health', () => results);
    seed(['https://a.com']);

    await startHealthScan();

    expect(useAppStore.getState().jobs.health).toMatchObject({ done: 1, failed: 0 });
    expect(useAppStore.getState().healthMeta.hasRun).toBe(true);
    expect(toasts().join('\n')).toContain('Check finished');
  });

  it('closes with the language that is active when the scan ends', async () => {
    const pending = deferred<LinkHealthResult[]>();
    rust.on('check_links_health', () => pending.promise);
    seed(['https://a.com']);

    const run = startHealthScan();
    useAppStore.getState().setLang('tr');
    pending.resolve([]);
    await run;

    expect(toasts().join('\n')).toContain('Kontrol bitti');
  });

  it('can be started again after finishing one threw', async () => {
    seed(['https://a.com']);
    const pushToast = useAppStore.getState().pushToast;
    useAppStore.setState({
      pushToast: () => {
        throw new Error('the summary blew up');
      },
    });

    await expect(startHealthScan()).rejects.toThrow('the summary blew up');

    useAppStore.setState({ pushToast });
    await startHealthScan();
    expect(rust.countOf('check_links_health')).toBe(2);
  });

  it('ignores a second start while a scan is running', async () => {
    const pending = deferred<LinkHealthResult[]>();
    rust.on('check_links_health', () => pending.promise);
    seed(['https://a.com', 'https://b.com']);

    const first = startHealthScan();
    await startHealthScan();
    pending.resolve([]);
    await first;

    expect(rust.countOf('check_links_health')).toBe(1);
    expect(toasts().filter((m) => m.includes('Check finished'))).toHaveLength(1);
  });

  it('stops before any chunk starts when cancelled while the scan is still starting', async () => {
    seed(['https://a.com', 'https://b.com']);

    const run = startHealthScan();
    cancelHealthScan();
    await run;

    expect(rust.countOf('check_links_health')).toBe(0);
    expect(useAppStore.getState().jobs.health).toMatchObject({ state: 'cancelled' });
    expect(toasts().join(' ')).toContain('Check cancelled');
    // The next scan can start: the cancelled one is no longer registered.
    await startHealthScan();
    expect(rust.countOf('check_links_health')).toBe(1);
  });

  it('finishes the other chunks while one chunk hangs, and cancel stops the one in flight', async () => {
    const hanging = deferred<LinkHealthResult[]>();
    const urls = Array.from({ length: HEALTH_CHUNK_SIZE * 4 }, (_, i) => `https://site${i}.com/`);
    rust.on('check_links_health', (args) =>
      (args.urls as string[]).includes(urls[0] as string) ? hanging.promise : [],
    );
    rust.on('cancel_health_scan', () => {
      hanging.resolve([]);
      return null;
    });
    seed(urls);

    const run = startHealthScan();
    await vi.waitFor(() => expect(rust.countOf('check_links_health')).toBe(4));
    await vi.waitFor(() =>
      expect(useAppStore.getState().jobs.health).toMatchObject({
        state: 'running',
        done: HEALTH_CHUNK_SIZE * 3,
      }),
    );

    cancelHealthScan();
    await run;

    expect(rust.argsOf('cancel_health_scan')).toHaveLength(1);
    expect(useAppStore.getState().jobs.health).toMatchObject({ state: 'cancelled', failed: 0 });
    expect(toasts().join(' ')).toContain('Check cancelled');
  });

  it('keeps checking other hosts while one host hangs', async () => {
    // Like Rust: other hosts' URLs in a call are checked, but its a.com URLs wait on the gate.
    const gate = deferred<LinkHealthResult[]>();
    const hostA = Array.from({ length: 152 }, (_, i) => `https://a.com/${i}`);
    const others = Array.from({ length: 150 }, (_, i) => `https://${i % 2 ? 'b' : 'c'}.com/${i}`);
    const checked = new Set<string>();
    rust.on('check_links_health', (args) => {
      const urls = args.urls as string[];
      const slow = urls.filter((url) => url.startsWith('https://a.com/'));
      urls.filter((url) => !slow.includes(url)).forEach((url) => checked.add(url));
      return slow.length > 0 ? gate.promise : [];
    });
    seed([...hostA, ...others]);

    const run = startHealthScan();
    await vi.waitFor(() => expect(checked.size).toBe(others.length));
    expect(useAppStore.getState().jobs.health).toMatchObject({ state: 'running' });

    gate.resolve([]);
    await run;
    expect(useAppStore.getState().jobs.health).toMatchObject({ state: 'done', done: 302 });
  });
});
