/**
 * Snapshot / preview media IPC wrappers. The renderer only stores file names, converted to
 * asset URLs via `snapshotSrc()`; the webview never loads a remote image directly.
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { call, IpcError } from './ipc';
import type { RemoteImageKind, SnapshotMaintenanceReport, SnapshotResult } from './ipcTypes';
import { isSafeFileName } from '../lib/files';

// Rust's 60 s starts at a permit (2 at a time), but this clock also counts the wait for one.
const CAPTURE_TIMEOUT_MS = 200_000;
// Rust web client: 15 s per request.
const CACHE_IMAGE_TIMEOUT_MS = 30_000;

let snapshotDir: string | null = null;

const joinPath = (base: string, fileName: string): string => {
  const separator = base.includes('\\') ? '\\' : '/';
  return base.endsWith(separator) ? `${base}${fileName}` : `${base}${separator}${fileName}`;
};

/** Test helper: forgets the cached snapshot directory. */
export const resetSnapshotDirForTests = (): void => {
  snapshotDir = null;
  replaced.clear();
};

/** Call once at app start; caches the snapshot directory for `snapshotSrc()`. */
export const initSnapshotDir = async (): Promise<void> => {
  snapshotDir = await call<string>('get_snapshot_dir');
};

/**
 * Cache key of this app run: a file rewritten under the same name in another run must not come
 * back from the webview cache. Files replaced during this run get a counter on top.
 */
const RUN_VERSION = Date.now().toString(36);
const replaced = new Map<string, number>();

/** Marks a file as rewritten in place, so its next `snapshotSrc()` URL loads the new content. */
export const markSnapshotReplaced = (fileName: string): void => {
  replaced.set(fileName, (replaced.get(fileName) ?? 0) + 1);
};

/** Asset URL for a snapshot file name. Returns '' before `initSnapshotDir()` or for bad names. */
export const snapshotSrc = (fileName: string): string => {
  if (!snapshotDir || !isSafeFileName(fileName)) return '';
  const count = replaced.get(fileName);
  const version = count === undefined ? RUN_VERSION : `${RUN_VERSION}.${count}`;
  // The asset protocol serves the path only; the query just changes the cache key.
  return `${convertFileSrc(joinPath(snapshotDir, fileName))}?v=${version}`;
};

/** Captures a page screenshot; every page-level outcome resolves via `SnapshotResult.kind`. */
export const captureSnapshot = (url: string): Promise<SnapshotResult> =>
  call<SnapshotResult>('capture_snapshot', { url }, { timeoutMs: CAPTURE_TIMEOUT_MS });

/** Stops every capture of this app that is in flight; each one then settles as cancelled. */
export const cancelSnapshotCaptures = (): Promise<void> => call<void>('cancel_snapshot_captures');

/** Stores a user-provided preview image; bytes travel as a raw IPC body, id/ext in headers. */
export const saveUploadedPreview = async (
  resourceId: string,
  bytes: Uint8Array,
  ext: 'png' | 'jpg' | 'webp',
): Promise<string> => {
  if (bytes.byteLength === 0) {
    throw new IpcError('invalidInput', 'Preview image is empty.');
  }
  return call<string>('save_uploaded_preview', bytes, {
    headers: { 'x-resource-id': encodeURIComponent(resourceId), 'x-ext': ext },
  });
};

/** Downloads a remote favicon/og:image (SSRF-guarded); render the result via `snapshotSrc()`. */
export const cacheRemoteImage = (url: string, kind: RemoteImageKind): Promise<string> =>
  call<string>('cache_remote_image', { url, kind }, { timeoutMs: CACHE_IMAGE_TIMEOUT_MS });

/** Start-up maintenance: deletes unreferenced files, evicts LRU files above 500 MB. */
export const maintainSnapshots = (keepFileNames: string[]): Promise<SnapshotMaintenanceReport> =>
  call<SnapshotMaintenanceReport>('maintain_snapshots', { keepFileNames });

/** Current size of the snapshot directory in bytes. */
export const snapshotDirBytes = (): Promise<number> => call<number>('snapshot_dir_bytes');

export const deleteSnapshots = (fileNames: string[]): Promise<void> =>
  fileNames.length === 0 ? Promise.resolve() : call<void>('delete_snapshots', { fileNames });

/** Factory reset: deletes every snapshot-directory file, uploads included. */
export const resetSnapshots = (): Promise<number> => call<number>('reset_snapshots');
