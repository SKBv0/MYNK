/**
 * Preview capture queue: one capture at a time, timeout lives in Rust. `runtimeMissing` arrives
 * as a result kind, not a rejection, and stops the queue (reported once per session).
 */
import {
  cancelSnapshotCaptures,
  captureSnapshot,
  deleteSnapshots,
  initSnapshotDir,
  maintainSnapshots,
  markSnapshotReplaced,
  resetSnapshots,
  saveUploadedPreview,
  snapshotDirBytes,
} from '../../services/snapshots';
import { IpcError, isDesktopRuntime } from '../../services/ipc';
import type { SnapshotResult } from '../../services/ipcTypes';
import { JobQueue } from '../../services/jobs/jobQueue';
import { mediaFilesOf } from '../../services/resourceMedia';
import { errorKind, reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import type { MediaPatch, Resource } from '../../types';
import { getT, useAppStore } from '../index';
import { needsPreview, resourceById } from '../selectors';
import { drainRetiredQueue, publishJob, toJobState } from './shared';
import { isLibraryWriteBlocked } from '../persistence';
import {
  cancelMediaCache,
  clearMediaReferences,
  flushMediaPatches,
  startMediaBackfill,
} from './media';

/** Same limit as Rust (`snapshot::cleanup::MAX_UPLOAD_BYTES`). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

interface PreviewCounters {
  captured: number;
  challenge: number;
  /** Real failures: a rejected capture or a failed result (published as the job's `failed`). */
  failed: number;
}

let queue: JobQueue<SnapshotResult> | null = null;
let runtimeMissingNotified = false;
let mediaInitStarted = false;
/** Bumped by every size reading, so an older answer never overwrites a newer one. */
let cacheBytesReading = 0;

const store = () => useAppStore.getState();

/** Every snapshot-directory file referenced by the resources (snapshots, uploads, cache). */
const snapshotFilesOf = (resources: Resource[]): string[] => [
  ...new Set(resources.flatMap(mediaFilesOf)),
];

/**
 * Deletes files no resource references; pending media patches are flushed first since one may be
 * the last reference. A blocked library deletes nothing: its records would point at missing files.
 */
const deleteFiles = (files: string[]) => {
  if (files.length === 0 || !isDesktopRuntime() || isLibraryWriteBlocked()) return;
  flushMediaPatches();
  const stillUsed = new Set(snapshotFilesOf(store().resources));
  const unused = [...new Set(files)].filter((file) => !stillUsed.has(file));
  if (unused.length === 0) return;
  deleteSnapshots(unused).catch((error: unknown) => reportError(error, 'snapshots.delete'));
};

/**
 * Points a record at a newly stored preview file and drops the one it replaces. Rust reuses a
 * name for the same page, so an unchanged name still gets a new URL and a new record object.
 */
const storePreviewFile = (
  id: string,
  previous: string | undefined,
  fileName: string,
  patch: (file: string | undefined) => MediaPatch,
) => {
  if (previous === fileName) {
    markSnapshotReplaced(fileName);
    store().applyPreview(id, patch(undefined));
  }
  store().applyPreview(id, patch(fileName));
  if (previous && previous !== fileName) deleteFiles([previous]);
};

/** Translates Rust's stable failure code; an unknown code shows nothing extra. */
export const previewFailureMessage = (reason: string | undefined): string => {
  const t = getT();
  const reasons: Record<string, string> = t.jobs.previewReasons;
  const text = reason && Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
  return text ? `${t.jobs.previewFailed}: ${text}` : t.jobs.previewFailed;
};

/** Result of a capture stopped by {@link cancelPreviewCapture}: neither captured nor failed. */
const CANCELLED_CAPTURE: SnapshotResult = { kind: 'error', reason: 'cancelled' };

const isCancelledCapture = (result: SnapshotResult): boolean =>
  result.kind === 'error' && result.reason === 'cancelled';

const notifyRuntimeMissing = () => {
  if (runtimeMissingNotified) return;
  runtimeMissingNotified = true;
  store().pushToast(getT().jobs.previewRuntimeMissing, 'error', { durationMs: 12_000 });
};

const createQueue = (): { q: JobQueue<SnapshotResult>; counters: PreviewCounters } => {
  const startedAt = Date.now();
  const counters: PreviewCounters = { captured: 0, challenge: 0, failed: 0 };
  const q: JobQueue<SnapshotResult> = new JobQueue<SnapshotResult>({
    concurrency: 1,
    onProgress: (p) =>
      publishJob(
        'preview',
        startedAt,
        // A capture that resolves with a failure is a queue success; the queue does not count it.
        {
          state: toJobState(p.state),
          total: p.total,
          done: p.done + p.failed,
          failed: counters.failed,
        },
        { captured: counters.captured, challenge: counters.challenge },
      ),
    onTaskStart: (id) => store().setBusy('preview', id, true),
    onTaskSettled: (id) => store().setBusy('preview', id, false),
    onTaskSuccess: (id, result) => {
      if (isCancelledCapture(result)) return;
      if (result.kind === 'runtimeMissing') {
        // Every other capture would fail the same way.
        q.cancel();
        notifyRuntimeMissing();
        return;
      }
      const resource = resourceById(store().resources, id);
      if (!resource) return;
      const t = getT();
      const single = q.progress.total === 1;
      if (result.kind === 'image' && result.fileName) {
        storePreviewFile(id, resource.media.snapshotFile, result.fileName, (snapshotFile) => ({
          snapshotFile,
          challenge: undefined,
        }));
        counters.captured += 1;
        if (single) store().pushToast(t.jobs.previewUpdated, 'success');
      } else if (result.kind === 'challenge') {
        store().applyPreview(id, { challenge: true });
        counters.challenge += 1;
        if (single) store().pushToast(t.jobs.previewChallenge, 'info');
      } else {
        counters.failed += 1;
        if (single) {
          store().pushToast(previewFailureMessage(result.reason), 'error');
        }
      }
    },
    onTaskError: (_id, error) => {
      if (error.kind === 'cancelled') return;
      counters.failed += 1;
      if (q.progress.total === 1)
        reportError(error, 'preview', { prefix: getT().jobs.previewFailed });
    },
  });
  return { q, counters };
};

/** Runs once the queue has drained (attached after the first `add`: a fresh queue is idle). */
const onQueueIdle = (q: JobQueue<SnapshotResult>, counters: PreviewCounters) =>
  void q.whenIdle().then((final) => {
    if (queue === q) queue = null;
    // A cancelled run's untried targets are neither captured nor failed; only report real outcomes.
    if (final.total > 1 || final.state === 'cancelled') {
      const t = getT();
      store().pushToast(
        fmt(final.state === 'cancelled' ? t.jobs.previewCancelled : t.jobs.previewFinished, {
          captured: counters.captured,
          challenge: counters.challenge,
          failed: counters.failed,
        }),
        'info',
      );
    }
  });

/** Captures previews for the given ids (or every resource missing one). */
export const startPreviewCapture = async (ids?: string[]): Promise<void> => {
  const t = getT();
  if (!isDesktopRuntime()) {
    store().pushToast(t.errors.desktopOnly, 'info');
    return;
  }
  // A cancelled run can still have one capture in flight; captures never overlap.
  await drainRetiredQueue(
    () => queue,
    (retired) => {
      if (queue === retired) queue = null;
    },
  );
  const resources = store().resources;
  const targets = ids
    ? resources.filter((r) => ids.includes(r.id))
    : resources.filter((r) => needsPreview(r));
  if (targets.length === 0) {
    store().pushToast(t.jobs.previewNothing, 'info');
    return;
  }
  const existing = queue?.isActive ? queue : null;
  const created = existing ? null : createQueue();
  const q = existing ?? created?.q;
  if (!q) return;
  if (created) queue = created.q;
  q.add(
    targets.map((target) => ({
      targetId: target.id,
      run: () => {
        const current = resourceById(store().resources, target.id);
        if (!current) return Promise.reject(new IpcError('notFound', 'Resource was removed.'));
        return captureSnapshot(current.url).catch((error: unknown) => {
          // The HUD counts a rejection as failed; a capture the user stopped is not a failure.
          if (errorKind(error) === 'cancelled') return CANCELLED_CAPTURE;
          throw error;
        });
      },
    })),
  );
  if (created) onQueueIdle(created.q, created.counters);
  await q.whenIdle();
};

/** Re-captures a single resource (card / inspector refresh button). */
export const refreshPreview = (id: string): Promise<void> => startPreviewCapture([id]);

/** Stops the queue and the capture in flight, so its browser does not run into the timeout. */
export const cancelPreviewCapture = (): void => {
  const q = queue;
  if (!q?.isActive) return;
  const capturing = q.progress.running > 0;
  q.cancel();
  if (capturing && isDesktopRuntime()) {
    cancelSnapshotCaptures().catch((error: unknown) =>
      reportError(error, 'snapshots.cancel', { toast: false }),
    );
  }
};
export const pausePreviewCapture = (): void => queue?.pause();
export const resumePreviewCapture = (): void => queue?.resume();

/** Test helper: drops the running queue and the once-per-session flags. */
export const resetPreviewForTests = (): void => {
  queue?.cancel();
  queue = null;
  runtimeMissingNotified = false;
  mediaInitStarted = false;
  cacheBytesReading = 0;
};

const UPLOAD_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Stores a user-selected preview image for a resource. */
export const uploadPreview = async (resourceId: string, file: File): Promise<void> => {
  const t = getT();
  if (!isDesktopRuntime()) {
    store().pushToast(t.errors.desktopOnly, 'info');
    return;
  }
  const ext = UPLOAD_TYPES[file.type];
  if (!ext) {
    store().pushToast(t.jobs.uploadUnsupported, 'error');
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    store().pushToast(t.jobs.uploadTooLarge, 'error');
    return;
  }
  store().setBusy('preview', resourceId, true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileName = await saveUploadedPreview(resourceId, bytes, ext);
    const previous = resourceById(store().resources, resourceId)?.media.uploadedFile;
    storePreviewFile(resourceId, previous, fileName, (uploadedFile) => ({ uploadedFile }));
    store().pushToast(t.jobs.uploadDone, 'success');
  } catch (error) {
    if (errorKind(error) === 'invalidInput') {
      // Rust rejected the file itself; say so instead of the generic AI-provider-settings text.
      reportError(error, 'preview.upload', { toast: false });
      store().pushToast(t.jobs.uploadInvalid, 'error');
    } else {
      reportError(error, 'preview.upload', { prefix: t.jobs.uploadFailed });
    }
  } finally {
    store().setBusy('preview', resourceId, false);
  }
};

/** Removes resources and their media files (files still used by other resources are kept). */
export const deleteResourcesWithMedia = (ids: string[]): Resource[] => {
  const removed = store().removeResources(ids);
  deleteFiles(snapshotFilesOf(removed));
  return removed;
};

/** Outcome of a factory reset; `blocked` means nothing was touched. */
export type ResetOutcome =
  | { state: 'blocked' }
  /** `deletedFiles` is null outside the desktop app, where there are no files. */
  | { state: 'done'; deletedFiles: number | null }
  | { state: 'filesFailed'; error: unknown };

/** Factory reset: wipes library data and every snapshot / cached media file. */
export const resetLibraryWithMedia = async (): Promise<ResetOutcome> => {
  // Same rule as `deleteFiles`: an unreadable library file would survive the wipe of its media.
  if (isLibraryWriteBlocked()) return { state: 'blocked' };
  cancelPreviewCapture();
  cancelMediaCache();
  store().resetLibrary();
  if (!isDesktopRuntime()) return { state: 'done', deletedFiles: null };
  try {
    // Snapshot maintenance keeps uploads and fresh files by design; a reset must remove them too.
    const deletedFiles = await resetSnapshots();
    cacheBytesReading += 1;
    store().setSnapshotCacheBytes(0);
    return { state: 'done', deletedFiles };
  } catch (error) {
    return { state: 'filesFailed', error };
  }
};

/** Re-reads the snapshot directory size shown in Settings; captures and deletes change it. */
export const refreshSnapshotCacheBytes = async (): Promise<void> => {
  if (!isDesktopRuntime() || !store().mediaReady) return;
  cacheBytesReading += 1;
  const reading = cacheBytesReading;
  try {
    const bytes = await snapshotDirBytes();
    if (reading === cacheBytesReading) store().setSnapshotCacheBytes(bytes);
  } catch (error) {
    reportError(error, 'snapshots.size', { toast: false });
  }
};

/**
 * Once per app start: resolves the snapshot dir, runs maintenance, backfills remote media.
 * `libraryLoaded: false` skips maintenance: an empty keep-list would delete every file on disk.
 */
export const initMediaOnce = async (options: { libraryLoaded?: boolean } = {}): Promise<void> => {
  if (mediaInitStarted || !isDesktopRuntime()) return;
  mediaInitStarted = true;
  try {
    await initSnapshotDir();
    store().setMediaReady(true);
  } catch (error) {
    reportError(error, 'snapshots.init');
    return;
  }
  if (options.libraryLoaded === false || isLibraryWriteBlocked()) {
    console.warn('[MYNK] library not loaded: snapshot maintenance and media backfill skipped.');
    return;
  }
  try {
    const report = await maintainSnapshots(snapshotFilesOf(store().resources));
    clearMediaReferences(report.evicted);
    cacheBytesReading += 1;
    store().setSnapshotCacheBytes(report.totalBytes);
  } catch (error) {
    reportError(error, 'snapshots.maintain', { toast: false });
  }
  startMediaBackfill().catch((error: unknown) =>
    reportError(error, 'media.backfill', { toast: false }),
  );
};
