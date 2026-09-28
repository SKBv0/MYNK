import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { mockRust, stopRust } from '../test/ipc';
import { errorMessage } from '../lib/errors';
import { IpcError } from './ipc';
import {
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  resetUpdaterForTests,
  toUpdateError,
  type DownloadProgress,
} from './updater';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(() => Promise.resolve()) }));

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

interface FakeUpdate {
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
  close: () => Promise<void>;
}

const fakeUpdate = (patch: Partial<FakeUpdate> = {}): FakeUpdate => ({
  version: '0.2.0',
  downloadAndInstall: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  ...patch,
});

/** The plugin's `Update` class is a backend resource; the tests only need its surface. */
const resolveWith = (update: FakeUpdate | null) => {
  vi.mocked(check).mockResolvedValue(update as never);
};

beforeEach(() => {
  resetUpdaterForTests();
  mockRust();
  vi.mocked(check).mockReset();
  vi.mocked(relaunch).mockClear();
});

afterEach(() => {
  resetUpdaterForTests();
  stopRust();
  vi.restoreAllMocks();
});

describe('checking for an update', () => {
  it('reports the version, date and notes the server sent', async () => {
    resolveWith(fakeUpdate({ date: '2026-09-14', body: 'Faster search.' }));

    expect(await checkForUpdate()).toEqual({
      version: '0.2.0',
      date: '2026-09-14',
      body: 'Faster search.',
    });
  });

  it('leaves a missing date and notes out instead of storing empty values', async () => {
    resolveWith(fakeUpdate());

    const info = await checkForUpdate();

    expect(info).toEqual({ version: '0.2.0' });
    expect(info && 'date' in info).toBe(false);
  });

  it('resolves to null and forgets the previous update when there is nothing new', async () => {
    resolveWith(fakeUpdate());
    await checkForUpdate();
    const first = fakeUpdate();
    resolveWith(null);

    expect(await checkForUpdate()).toBeNull();
    await expect(downloadAndInstall()).rejects.toMatchObject({ kind: 'notFound' });
    expect(first.close).not.toHaveBeenCalled();
  });

  it('closes the handle of the update it replaces', async () => {
    const first = fakeUpdate();
    resolveWith(first);
    await checkForUpdate();
    resolveWith(fakeUpdate({ version: '0.3.0' }));

    await checkForUpdate();

    expect(first.close).toHaveBeenCalled();
  });

  it('rejects outside the desktop app instead of calling the plugin', async () => {
    stopRust();
    await expect(checkForUpdate()).rejects.toMatchObject({ kind: 'desktopOnly' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('translating what the plugin rejects with', () => {
  it('names a failed signature check', () => {
    const error = toUpdateError(new Error('Signature mismatch'));
    expect(error.kind).toBe('parse');
    expect(errorMessage(error)).toContain('could not be verified as coming from MYNK');
  });

  it('names a release server with nothing for this computer', () => {
    const error = toUpdateError(new Error('Could not fetch a valid release JSON from the remote'));
    expect(error.kind).toBe('notFound');
    expect(errorMessage(error)).toContain('no update for this computer');
  });

  it('keeps a network failure a network failure', () => {
    expect(toUpdateError(new Error('error sending request for url')).kind).toBe('network');
    expect(toUpdateError('request timed out').kind).toBe('timeout');
  });

  it('falls back to an unexpected error, and never re-wraps an IpcError', () => {
    expect(toUpdateError(new Error('something else entirely')).kind).toBe('internal');
    const original = new IpcError('desktopOnly', 'no runtime');
    expect(toUpdateError(original)).toBe(original);
  });

  it('is what the check rejects with', async () => {
    vi.mocked(check).mockRejectedValue(new Error('Signature mismatch'));
    await expect(checkForUpdate()).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('installing', () => {
  it('reports progress while downloading and hands the package to the installer', async () => {
    const seen: DownloadProgress[] = [];
    const update = fakeUpdate({
      downloadAndInstall: vi.fn((onEvent?: (event: DownloadEvent) => void) => {
        onEvent?.({ event: 'Started', data: { contentLength: 1000 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 400 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 300 } });
        onEvent?.({ event: 'Finished' });
        return Promise.resolve();
      }),
    });
    resolveWith(update);
    await checkForUpdate();

    await downloadAndInstall((progress) => seen.push(progress));

    expect(seen).toEqual([
      { downloaded: 0, total: 1000 },
      { downloaded: 400, total: 1000 },
      { downloaded: 700, total: 1000 },
      { downloaded: 1000, total: 1000 },
    ]);
  });

  it('refuses to install without a check', async () => {
    await expect(downloadAndInstall()).rejects.toMatchObject({ kind: 'notFound' });
  });

  it('translates a failure of the install itself', async () => {
    resolveWith(
      fakeUpdate({
        downloadAndInstall: vi.fn(() => Promise.reject(new Error('error sending request'))),
      }),
    );
    await checkForUpdate();

    await expect(downloadAndInstall()).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('restarting', () => {
  it('asks the process plugin to relaunch', async () => {
    await relaunchApp();
    expect(relaunch).toHaveBeenCalled();
  });

  it('does nothing outside the desktop app', async () => {
    stopRust();
    await expect(relaunchApp()).rejects.toMatchObject({ kind: 'desktopOnly' });
    expect(relaunch).not.toHaveBeenCalled();
  });
});
