import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRust, stopRust } from '../../test/ipc';
import { IpcError } from '../../services/ipc';
import {
  checkForUpdate,
  downloadAndInstall,
  relaunchApp,
  type DownloadProgress,
} from '../../services/updater';
import { useAppStore } from '../index';
import {
  installUpdate,
  isUpdateCheckDue,
  resetUpdateJobForTests,
  runSilentUpdateCheck,
  startUpdateWatch,
  updateWatchGate,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECKED_AT_KEY,
} from './update';

vi.mock('../../services/updater', () => ({
  checkForUpdate: vi.fn(() => Promise.resolve(null)),
  downloadAndInstall: vi.fn(() => Promise.resolve()),
  relaunchApp: vi.fn(() => Promise.resolve()),
}));

const PRISTINE = useAppStore.getState();

const toasts = () => useAppStore.getState().toasts;
const messages = () => toasts().map((toast) => toast.message);

/** The action button of the newest toast that has one. */
const action = () => [...toasts()].reverse().find((toast) => toast.action)?.action;

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
  resetUpdateJobForTests();
  window.localStorage.clear();
  mockRust();
  vi.mocked(checkForUpdate).mockReset().mockResolvedValue(null);
  vi.mocked(downloadAndInstall).mockReset().mockResolvedValue();
  vi.mocked(relaunchApp).mockReset().mockResolvedValue();
});

afterEach(() => {
  resetUpdateJobForTests();
  stopRust();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the daily check', () => {
  it('never runs in a dev build, which would be offered the published release', async () => {
    vi.useFakeTimers();
    updateWatchGate.enabled = false;
    startUpdateWatch({ libraryLoaded: true });

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS * 2);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('is off by default under the dev server', async () => {
    vi.resetModules();
    const fresh = await import('./update');
    expect(import.meta.env.DEV).toBe(true);
    expect(fresh.updateWatchGate.enabled).toBe(false);
  });

  it('runs once, twenty seconds after the app started', async () => {
    vi.useFakeTimers();
    startUpdateWatch({ libraryLoaded: true });

    expect(checkForUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    startUpdateWatch({ libraryLoaded: true });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not check again within a day, and does again after one', () => {
    vi.useFakeTimers();
    const now = Date.now();
    window.localStorage.setItem(UPDATE_CHECKED_AT_KEY, String(now - 1000));

    expect(isUpdateCheckDue(now)).toBe(false);
    startUpdateWatch({ libraryLoaded: true });
    vi.advanceTimersByTime(UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).not.toHaveBeenCalled();

    expect(isUpdateCheckDue(now + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('keeps checking once a day while the app stays open', async () => {
    vi.useFakeTimers();
    startUpdateWatch({ libraryLoaded: true });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1000);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('checks when the day since the last check is over, even if that is after the start', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(UPDATE_CHECKED_AT_KEY, String(Date.now() - 1000));
    startUpdateWatch({ libraryLoaded: true });

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 2000);
    expect(checkForUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('waits a day between checks even when the stamp cannot be stored', async () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    startUpdateWatch({ libraryLoaded: true });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1000);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('checks again when the stamp is in the future, so a wrong clock cannot suppress updates', () => {
    const now = Date.now();
    window.localStorage.setItem(UPDATE_CHECKED_AT_KEY, String(now + 50 * UPDATE_CHECK_INTERVAL_MS));
    expect(isUpdateCheckDue(now)).toBe(true);
  });

  it('does not check when the app could not load its library', () => {
    vi.useFakeTimers();
    startUpdateWatch({ libraryLoaded: false });
    vi.advanceTimersByTime(UPDATE_CHECK_DELAY_MS);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('stamps the time it ran outside the library file', async () => {
    await runSilentUpdateCheck();
    const stamped = Number(window.localStorage.getItem(UPDATE_CHECKED_AT_KEY));
    expect(stamped).toBeGreaterThan(0);
    expect(isUpdateCheckDue()).toBe(false);
  });

  it('says nothing when the installed version is the newest one', async () => {
    await runSilentUpdateCheck();
    expect(messages()).toEqual([]);
  });

  it('shows nothing when the release server is unreachable, and still waits a day', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(checkForUpdate).mockRejectedValue(
      new IpcError('notFound', 'Could not fetch a valid release JSON from the remote'),
    );

    await runSilentUpdateCheck();

    expect(messages()).toEqual([]);
    expect(warnings).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(isUpdateCheckDue()).toBe(false);
  });
});

describe('a newer version', () => {
  it('offers it in a toast that stays until it is answered', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({ version: '0.2.0' });

    await runSilentUpdateCheck();

    expect(messages()).toEqual(['MYNK 0.2.0 is ready to install.']);
    expect(action()?.label).toBe('Install');
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it('takes the offer back when a later check closes the handle behind it', async () => {
    vi.mocked(checkForUpdate).mockResolvedValueOnce({ version: '0.2.0' });
    await runSilentUpdateCheck();
    expect(messages()).toEqual(['MYNK 0.2.0 is ready to install.']);

    await runSilentUpdateCheck();

    expect(messages()).toEqual([]);
  });

  it('downloads on the action, shows progress and then offers the restart', async () => {
    vi.mocked(downloadAndInstall).mockImplementation(
      (onProgress?: (progress: DownloadProgress) => void) => {
        onProgress?.({ downloaded: 0, total: 1000 });
        onProgress?.({ downloaded: 500, total: 1000 });
        expect(messages()).toEqual(['MYNK 0.2.0 is ready to install.', expect.any(String)]);
        expect(messages()[1]).toContain('50%');
        return Promise.resolve();
      },
    );
    vi.mocked(checkForUpdate).mockResolvedValue({ version: '0.2.0' });
    await runSilentUpdateCheck();

    await installUpdate('0.2.0');

    expect(messages()).toEqual([
      'MYNK 0.2.0 is ready to install.',
      'MYNK 0.2.0 has been installed.',
    ]);
    const restart = action();
    expect(restart?.label).toBe('Restart');
    restart?.run();
    await Promise.resolve();
    expect(relaunchApp).toHaveBeenCalled();
  });

  it('reports a failed install once, because the user asked for it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(downloadAndInstall).mockRejectedValue(new IpcError('network', 'no route'));

    await installUpdate('0.2.0');

    expect(messages().join('\n')).toContain('The update could not be installed');
    expect(messages().join('\n')).toContain('Could not reach the server');
    expect(messages().some((message) => message.includes('Downloading'))).toBe(false);
  });

  it('ignores a second press while the first install is running', async () => {
    let release = () => undefined as void;
    vi.mocked(downloadAndInstall).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const first = installUpdate('0.2.0');
    await installUpdate('0.2.0');
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });
});
