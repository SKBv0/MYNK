/**
 * Update job: checks for a newer MYNK at most once a day in the background; a failed check is
 * logged, never shown. The last-checked stamp lives in `localStorage`, not `library.json`.
 */
import { checkForUpdate, downloadAndInstall, relaunchApp } from '../../services/updater';
import { isDesktopRuntime } from '../../services/ipc';
import { reportError } from '../../lib/errors';
import { formatNumber } from '../../lib/format';
import { fmt } from '../../lib/text';
import { getT, useAppStore } from '../index';

export const UPDATE_CHECK_DELAY_MS = 20_000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Where the last check is stamped (never in `library.json`). */
export const UPDATE_CHECKED_AT_KEY = 'mynk.updateCheckedAt';

/** Off in dev and e2e runs, which would otherwise be offered the published release. */
export const updateWatchGate = { enabled: !import.meta.env.DEV };

const store = () => useAppStore.getState();

let timer: ReturnType<typeof setTimeout> | null = null;
let scheduled = false;
let installing = false;
/** The progress toast currently on screen, so it is replaced instead of stacked. */
let progressToast: string | null = null;
/** The "ready to install" toast; its action is invalid once the next check closes the handle. */
let announcementToast: string | null = null;
let lastPercent = -1;
/** This session's last check: a storage that refuses writes must not turn it into a loop. */
let checkedThisSession = 0;

/** `localStorage` can throw in private browsing; a check that forgets it ran reruns next start. */
const readCheckedAt = (): number => {
  try {
    const raw = window.localStorage.getItem(UPDATE_CHECKED_AT_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Math.max(Number.isFinite(value) ? value : 0, checkedThisSession);
  } catch {
    return checkedThisSession;
  }
};

const writeCheckedAt = (at: number): void => {
  checkedThisSession = at;
  try {
    window.localStorage.setItem(UPDATE_CHECKED_AT_KEY, String(at));
  } catch {
    // The next start checks again.
  }
};

export const isUpdateCheckDue = (now: number = Date.now()): boolean => {
  const elapsed = now - readCheckedAt();
  // A stamp in the future came from a wrong clock; without this it would suppress updates.
  return elapsed < 0 || elapsed >= UPDATE_CHECK_INTERVAL_MS;
};

const clearProgress = (): void => {
  if (progressToast !== null) {
    store().dismissToast(progressToast);
    progressToast = null;
  }
  lastPercent = -1;
};

/** No "update this toast" call exists, so the previous progress toast is dismissed first. */
const showProgress = (version: string, percent: number | null): void => {
  const t = getT();
  const rounded = percent === null ? -1 : Math.min(100, Math.max(0, Math.round(percent)));
  if (rounded === lastPercent) return;
  lastPercent = rounded;
  const message =
    rounded < 0
      ? fmt(t.updates.downloading, { version })
      : fmt(t.updates.downloadingPercent, {
          version,
          percent: formatNumber(rounded),
        });
  if (progressToast !== null) store().dismissToast(progressToast);
  progressToast = store().pushToast(message, 'info', { durationMs: 0 });
};

/** Downloads and installs the found update; on Windows the installer exits MYNK, no restart. */
export const installUpdate = async (version: string): Promise<void> => {
  if (installing) return;
  installing = true;
  lastPercent = -1;
  try {
    showProgress(version, null);
    await downloadAndInstall(({ downloaded, total }) => {
      showProgress(version, total && total > 0 ? (downloaded / total) * 100 : null);
    });
    clearProgress();
    const t = getT();
    store().pushToast(fmt(t.updates.installed, { version }), 'success', {
      durationMs: 0,
      action: {
        label: t.updates.restart,
        run: () => {
          void relaunchApp().catch((error: unknown) =>
            reportError(error, 'update.relaunch', { prefix: getT().updates.failed }),
          );
        },
      },
    });
  } catch (error) {
    clearProgress();
    // The user started this one, so it is the single place an update failure is shown.
    reportError(error, 'update.install', { prefix: getT().updates.failed });
  } finally {
    installing = false;
  }
};

/** Drops an announcement whose install handle a new check is about to replace. */
export const dismissUpdateAnnouncement = (): void => {
  if (announcementToast === null) return;
  store().dismissToast(announcementToast);
  announcementToast = null;
};

/** The "a newer MYNK is ready" toast, with the install the user has to press. */
export const announceUpdate = (version: string): void => {
  const t = getT();
  announcementToast = store().pushToast(fmt(t.updates.ready, { version }), 'info', {
    durationMs: 0,
    action: { label: t.updates.install, run: () => void installUpdate(version) },
  });
};

/** One background check: stamps the time, announces a newer version; failures go to the log. */
export const runSilentUpdateCheck = async (): Promise<void> => {
  if (!isDesktopRuntime()) return;
  dismissUpdateAnnouncement();
  try {
    const update = await checkForUpdate();
    if (update) announceUpdate(update.version);
  } catch (error) {
    // A background check: an unreachable endpoint is logged as a warning, not an error.
    console.warn('[MYNK] update.check:', error);
  } finally {
    // Stamped even after a failure, so a down server isn't retried on every start.
    writeCheckedAt(Date.now());
  }
};

/** Time until the next check is due, never sooner than the start-up delay. */
const nextCheckDelay = (now: number = Date.now()): number =>
  isUpdateCheckDue(now)
    ? UPDATE_CHECK_DELAY_MS
    : Math.max(UPDATE_CHECK_DELAY_MS, readCheckedAt() + UPDATE_CHECK_INTERVAL_MS - now);

const scheduleCheck = (delay: number): void => {
  timer = setTimeout(() => {
    timer = null;
    // A running install owns the update handle that a new check would close.
    const run = installing || !isUpdateCheckDue() ? Promise.resolve() : runSilentUpdateCheck();
    void run.finally(() => {
      if (scheduled) scheduleCheck(nextCheckDelay());
    });
  }, delay);
};

/** Once per app start, after hydration succeeded: checks when due, then daily while open. */
export const startUpdateWatch = (options: { libraryLoaded?: boolean } = {}): void => {
  if (scheduled || !updateWatchGate.enabled || !isDesktopRuntime()) return;
  if (options.libraryLoaded === false) return;
  scheduled = true;
  scheduleCheck(nextCheckDelay());
};

/** Test helper: cancels the scheduled check, forgets the toast in flight, allows the watch. */
export const resetUpdateJobForTests = (): void => {
  updateWatchGate.enabled = true;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  scheduled = false;
  installing = false;
  progressToast = null;
  announcementToast = null;
  lastPercent = -1;
  checkedThisSession = 0;
};
