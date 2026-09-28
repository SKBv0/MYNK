import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ipc')>();
  return { ...actual, isDesktopRuntime: () => false };
});
vi.mock('../services/library', () => ({
  loadLibrary: vi.fn(),
  saveLibrary: vi.fn(),
}));

import { useAppStore } from './index';
import {
  WRITE_DEBOUNCE_MS,
  WRITE_MAX_WAIT_MS,
  WRITE_RETRY_BASE_MS,
  SAVE_FAILURE_LIMIT,
  MAX_BACKUPS,
  __resetPersistenceForTests,
  flushPersistence,
  hydrateStore,
  isSaveFailing,
} from './persistence';
import { BACKUP_KEY_PREFIX, LIBRARY_STORAGE_KEY } from './migrate';
import { nth } from '../test/assert';
import { makeResource } from '../test/fixtures';

const initial = useAppStore.getState();

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState(initial, true);
  __resetPersistenceForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetPersistenceForTests();
});

describe('persistence (browser fallback)', () => {
  it('treats a library without a version field as damaged: backs it up and blocks writes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stored = JSON.stringify({
      resources: [{ id: 'a', url: 'https://a.com', title: 'A', createdAt: 1 }],
    });
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, stored);

    await expect(hydrateStore()).resolves.toEqual({ ok: false });

    const backups = Object.keys(window.localStorage).filter((k) => k.startsWith(BACKUP_KEY_PREFIX));
    expect(backups.map((k) => window.localStorage.getItem(k))).toEqual([stored]);
    useAppStore.getState().addResource({ url: 'https://new.com' });
    await flushPersistence();
    expect(window.localStorage.getItem(LIBRARY_STORAGE_KEY)).toBe(stored);
    error.mockRestore();
  });

  it('keeps what the user did while the library was still loading', async () => {
    const stored = makeResource({ url: 'https://stored.com/', title: 'Stored' });
    window.localStorage.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        savedAt: 1,
        resources: [stored],
        collections: [],
        chats: {},
        settings: { lang: 'en', themeMode: 'light', viewMode: 'timeline' },
        healthMeta: { hasRun: false, lastScanAt: null },
      }),
    );

    const hydrating = hydrateStore();
    useAppStore.getState().addResource({ url: 'https://early.com/' });
    useAppStore.getState().setLang('tr');
    await hydrating;

    const state = useAppStore.getState();
    expect(state.resources.map((r) => r.title)).toEqual(['early.com', 'Stored']);
    expect(state.lang).toBe('tr');
    // Settings the user did not touch still come from the file.
    expect(state.themeMode).toBe('light');
    expect(state.viewMode).toBe('timeline');
    const saved = JSON.parse(window.localStorage.getItem(LIBRARY_STORAGE_KEY) as string);
    expect(saved.resources).toHaveLength(2);
    expect(saved.settings.lang).toBe('tr');
  });

  it('also keeps an edit made while the post-load write was in flight', async () => {
    window.localStorage.setItem(
      LIBRARY_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        savedAt: 1,
        resources: [makeResource({ url: 'https://stored.com/', title: 'Stored' })],
        collections: [],
        chats: {},
        settings: { lang: 'en' },
        healthMeta: { hasRun: false, lastScanAt: null },
      }),
    );
    // The first write is the one that stores the early edit; a second edit lands during it.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockImplementationOnce(function (this: Storage, key: string, value: string) {
      useAppStore.getState().addResource({ url: 'https://during.com/' });
      setItem.mockRestore();
      window.localStorage.setItem(key, value);
    });

    const hydrating = hydrateStore();
    useAppStore.getState().addResource({ url: 'https://early.com/' });
    await hydrating;
    await flushPersistence();

    const saved = JSON.parse(window.localStorage.getItem(LIBRARY_STORAGE_KEY) as string);
    expect(saved.resources.map((r: { title: string }) => r.title)).toEqual([
      'during.com',
      'early.com',
      'Stored',
    ]);
  });

  it('writes what the user did while an absent library file was looked for', async () => {
    const hydrating = hydrateStore();
    useAppStore.getState().addResource({ url: 'https://first.com/' });
    await hydrating;

    const saved = JSON.parse(window.localStorage.getItem(LIBRARY_STORAGE_KEY) as string);
    expect(saved.resources.map((r: { title: string }) => r.title)).toEqual(['first.com']);
  });

  it('debounces writes and never writes for UI-only changes like search', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    useAppStore.getState().setSearchQuery('r');
    useAppStore.getState().setSearchQuery('re');
    useAppStore.getState().openModal('palette');
    useAppStore.getState().pushToast('hello');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 3);
    expect(setItem).not.toHaveBeenCalledWith(LIBRARY_STORAGE_KEY, expect.any(String));

    useAppStore.getState().addResource({ url: 'https://one.com' });
    useAppStore.getState().addResource({ url: 'https://two.com' });
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 50);
    expect(setItem).not.toHaveBeenCalledWith(LIBRARY_STORAGE_KEY, expect.any(String));
    await vi.advanceTimersByTimeAsync(100);
    const writes = setItem.mock.calls.filter(([key]) => key === LIBRARY_STORAGE_KEY);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(nth(writes, 0)[1]).resources).toHaveLength(2);
    setItem.mockRestore();
  });

  it('reports write failures instead of failing silently', async () => {
    await hydrateStore();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    useAppStore.getState().addResource({ url: 'https://big.com' });
    await flushPersistence();
    expect(useAppStore.getState().toasts.some((t) => t.type === 'error')).toBe(true);
    setItem.mockRestore();
  });

  // The agent inbox deletes entries once stored, so this answer must be accurate.
  it('says whether a flush reached the storage', async () => {
    await hydrateStore();
    expect(await flushPersistence()).toEqual({ ok: true });

    useAppStore.getState().addResource({ url: 'https://one.com' });
    expect(await flushPersistence()).toEqual({ ok: true });
    expect(isSaveFailing()).toBe(false);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('locked', 'InvalidStateError');
    });
    useAppStore.getState().addResource({ url: 'https://two.com' });
    expect(await flushPersistence()).toEqual({ ok: false });
    // A flush with nothing new to write is not "ok" either while the last write failed.
    expect(await flushPersistence()).toEqual({ ok: false });

    setItem.mockRestore();
    error.mockRestore();
  });

  it('flags the library as unsaveable after a streak of failed writes', async () => {
    await hydrateStore();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('locked', 'InvalidStateError');
    });

    for (let attempt = 1; attempt <= SAVE_FAILURE_LIMIT; attempt += 1) {
      // The streak only counts as "not being saved" once it reaches the limit.
      expect(isSaveFailing()).toBe(false);
      useAppStore.getState().addResource({ url: `https://fail-${attempt}.com` });
      await flushPersistence();
    }
    expect(isSaveFailing()).toBe(true);

    // One successful write clears the streak: the library is saveable again.
    setItem.mockRestore();
    useAppStore.getState().addResource({ url: 'https://works.com' });
    expect(await flushPersistence()).toEqual({ ok: true });
    expect(isSaveFailing()).toBe(false);
    error.mockRestore();
  });

  it('never persists transient state', async () => {
    await hydrateStore();
    useAppStore.getState().setSearchQuery('secret');
    useAppStore.getState().addResource({ url: 'https://x.com' });
    await flushPersistence();
    const saved = window.localStorage.getItem(LIBRARY_STORAGE_KEY) as string;
    expect(saved).not.toContain('secret');
    expect(saved).not.toContain('toasts');
    expect(saved).not.toContain('batchSelectedIds');
  });

  it('reports whether the library could be loaded', async () => {
    await expect(hydrateStore()).resolves.toEqual({ ok: true });
    __resetPersistenceForTests();
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, '{not json');
    await expect(hydrateStore()).resolves.toEqual({ ok: false });
  });
});

describe('persistence write scheduling', () => {
  const libraryWrites = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([key]) => key === LIBRARY_STORAGE_KEY);

  /** Counts error toasts as they are pushed (they auto-dismiss while fake time runs). */
  const countErrorToasts = () => {
    const counter = { value: 0, stop: () => undefined as void };
    counter.stop = useAppStore.subscribe((next, prev) => {
      if (next.toasts.length > prev.toasts.length && next.toasts.at(-1)?.type === 'error') {
        counter.value += 1;
      }
    });
    return counter;
  };

  it('writes at most WRITE_MAX_WAIT_MS after the first change, even under constant edits', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const step = WRITE_DEBOUNCE_MS - 100;
    const steps = Math.ceil(WRITE_MAX_WAIT_MS / step);

    // A change every 400 ms would keep resetting a plain 500 ms debounce.
    for (let i = 0; i < steps - 1; i += 1) {
      useAppStore.getState().addResource({ url: `https://site-${i}.com` });
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(libraryWrites(setItem)).toHaveLength(0);
    useAppStore.getState().addResource({ url: 'https://last.com' });
    await vi.advanceTimersByTimeAsync(step);

    const writes = libraryWrites(setItem);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(nth(writes, 0)[1] as string).resources.length).toBeGreaterThanOrEqual(
      steps - 1,
    );
    setItem.mockRestore();
  });

  it('retries a failed write with backoff until the latest content is on disk', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('locked', 'InvalidStateError');
    });

    useAppStore.getState().addResource({ url: 'https://one.com' });
    await flushPersistence();
    expect(window.localStorage.getItem(LIBRARY_STORAGE_KEY)).toBeNull();
    expect(useAppStore.getState().toasts.filter((t) => t.type === 'error')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WRITE_RETRY_BASE_MS);
    const saved = JSON.parse(window.localStorage.getItem(LIBRARY_STORAGE_KEY) as string);
    expect(saved.resources.map((r: { url: string }) => r.url)).toEqual(['https://one.com/']);
    expect(libraryWrites(setItem)).toHaveLength(2);

    // Nothing is left dirty: no further writes happen.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(libraryWrites(setItem)).toHaveLength(2);
    setItem.mockRestore();
  });

  it('keeps retrying with growing delays and shows one toast per failure streak', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errorToasts = countErrorToasts();
    let failures = 3;
    const realSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === LIBRARY_STORAGE_KEY && failures > 0) {
        failures -= 1;
        throw new DOMException('locked', 'InvalidStateError');
      }
      realSetItem.call(this, key, value);
    });

    useAppStore.getState().addResource({ url: 'https://one.com' });
    await flushPersistence();
    await vi.advanceTimersByTimeAsync(WRITE_RETRY_BASE_MS); // 2nd attempt fails
    expect(libraryWrites(setItem)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WRITE_RETRY_BASE_MS); // backoff doubled: not yet
    expect(libraryWrites(setItem)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WRITE_RETRY_BASE_MS); // 3rd attempt fails
    await vi.advanceTimersByTimeAsync(WRITE_RETRY_BASE_MS * 4); // 4th succeeds
    expect(libraryWrites(setItem)).toHaveLength(4);
    expect(window.localStorage.getItem(LIBRARY_STORAGE_KEY)).toContain('https://one.com/');
    // The first failure's short toast, then one lasting warning at SAVE_FAILURE_LIMIT.
    expect(errorToasts.value).toBe(2);
    errorToasts.stop();
    setItem.mockRestore();
    error.mockRestore();
  });

  it('keeps one lasting warning on screen while saves fail and clears it once one lands', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failing = true;
    const realSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === LIBRARY_STORAGE_KEY && failing)
        throw new DOMException('locked', 'InvalidStateError');
      realSetItem.call(this, key, value);
    });
    const warnings = () =>
      useAppStore
        .getState()
        .toasts.filter(
          (t) =>
            t.message ===
            'Your changes cannot be saved. MYNK keeps trying. Check that the library file is not read-only or open in another program.',
        );

    useAppStore.getState().addResource({ url: 'https://one.com' });
    await flushPersistence();
    for (let attempt = 1; attempt < SAVE_FAILURE_LIMIT; attempt += 1) {
      await vi.advanceTimersByTimeAsync(WRITE_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    expect(isSaveFailing()).toBe(true);
    expect(warnings()).toHaveLength(1);

    // Later failures and edits neither repeat it nor let it time out.
    useAppStore.getState().addResource({ url: 'https://two.com' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(libraryWrites(setItem).length).toBeGreaterThan(SAVE_FAILURE_LIMIT);
    expect(warnings()).toHaveLength(1);

    failing = false;
    const pushed: string[] = [];
    const stop = useAppStore.subscribe((next) => {
      for (const toast of next.toasts)
        if (!pushed.includes(toast.message)) pushed.push(toast.message);
    });
    await vi.advanceTimersByTimeAsync(120_000);
    stop();
    expect(isSaveFailing()).toBe(false);
    expect(warnings()).toHaveLength(0);
    expect(pushed).toContain('Saving works again.');
    setItem.mockRestore();
    error.mockRestore();
  });

  it('does not bypass the retry delay when edits keep coming during a failure streak', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('disk full', 'QuotaExceededError');
    });

    useAppStore.getState().addResource({ url: 'https://first.com' });
    await flushPersistence(); // attempt 1 fails, retry scheduled after WRITE_RETRY_BASE_MS
    const afterFirst = libraryWrites(setItem).length;

    // A change every 100 ms for 3 s (well past WRITE_MAX_WAIT_MS) must not force writes.
    for (let i = 0; i < 30; i += 1) {
      useAppStore.getState().addResource({ url: `https://edit-${i}.com` });
      await vi.advanceTimersByTimeAsync(100);
    }
    // Backoff 1 s, 2 s: at most two more attempts in 3 s, not one per edit.
    expect(libraryWrites(setItem).length - afterFirst).toBeLessThanOrEqual(2);

    setItem.mockRestore();
    error.mockRestore();
  });

  it('does not stay dirty when a failed write was superseded by a newer successful one', async () => {
    await hydrateStore();
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errorToasts = countErrorToasts();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('locked', 'InvalidStateError');
    });

    useAppStore.getState().addResource({ url: 'https://a.com' });
    void flushPersistence(); // A: queued, will fail
    useAppStore.getState().addResource({ url: 'https://b.com' });
    await flushPersistence(); // B: queued behind A, succeeds

    const saved = JSON.parse(window.localStorage.getItem(LIBRARY_STORAGE_KEY) as string);
    expect(saved.resources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(libraryWrites(setItem)).toHaveLength(2);
    // B made A's failure irrelevant: nothing to tell the user.
    expect(errorToasts.value).toBe(0);
    errorToasts.stop();
    setItem.mockRestore();
    error.mockRestore();
  });
});

describe('backups of an unreadable library', () => {
  it('keeps only the newest few, so a library it cannot parse does not fill the quota', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const stamp of [1, 2, 3, 4, 5]) {
      window.localStorage.setItem(`${BACKUP_KEY_PREFIX}${stamp}`, 'old');
    }
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, '{"version":3,"savedAt":1}');

    await hydrateStore();

    const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(BACKUP_KEY_PREFIX));
    const stamps = new Set(keys.map((k) => k.slice(BACKUP_KEY_PREFIX.length)));
    expect(stamps.size).toBe(MAX_BACKUPS);
    expect([...stamps]).toEqual(expect.arrayContaining(['4', '5']));
    expect(stamps.has('1')).toBe(false);
    error.mockRestore();
  });
});
