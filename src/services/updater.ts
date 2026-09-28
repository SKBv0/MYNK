/**
 * Automatic updates: thin wrapper over the `updater`/`process` Tauri plugins. Only a signed
 * update is ever installed. Nothing downloads by itself; installing is a separate call.
 */
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { desktopCall, IpcError } from './ipc';

/** What the release server says about the newer version. */
export interface UpdateInfo {
  version: string;
  /** Release date as the server wrote it, when it sent one. */
  date?: string;
  /** Release notes, when the release has any. */
  body?: string;
}

export interface DownloadProgress {
  /** Bytes fetched so far. */
  downloaded: number;
  /** Total size, when the server sent a content length. */
  total?: number;
}

/** Patterns that sort the plugin's raw error string into an `IpcError` kind. */
const SIGNATURE = /signature|minisign|public key|pubkey|base64/i;
const UNAVAILABLE = /release json|platforms|404|not found|no endpoints|endpoints set/i;
const TIMEOUT = /timed out|timeout/i;
const NETWORK = /network|dns|connect|error sending request|tcp|socket|os error|certificate|tls/i;

/** The plugin rejects with a plain string; `invoke` itself can reject with an object. */
const messageOf = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return String(error);
};

export const toUpdateError = (error: unknown): IpcError => {
  if (error instanceof IpcError) return error;
  const message = messageOf(error);
  if (SIGNATURE.test(message)) {
    return new IpcError('parse', message).withDetail({ key: 'updateSignature' });
  }
  if (UNAVAILABLE.test(message)) {
    return new IpcError('notFound', message).withDetail({ key: 'updateUnavailable' });
  }
  if (TIMEOUT.test(message)) return new IpcError('timeout', message);
  if (NETWORK.test(message)) return new IpcError('network', message);
  return new IpcError('internal', message);
};

/** The update `check()` found, kept for the install that may follow. */
let pending: Update | null = null;

const forget = (): void => {
  const previous = pending;
  pending = null;
  // Best effort: an already-gone handle must not fail the check that replaced it.
  if (previous) void previous.close().catch(() => undefined);
};

/** Looks for a newer version; resolves `null` when already up to date. Nothing is downloaded. */
export const checkForUpdate = async (): Promise<UpdateInfo | null> => {
  const update = await desktopCall(() => check(), toUpdateError);
  forget();
  if (!update) return null;
  pending = update;
  const info: UpdateInfo = { version: update.version };
  if (update.date !== undefined) info.date = update.date;
  if (update.body !== undefined) info.body = update.body;
  return info;
};

/**
 * Downloads the update {@link checkForUpdate} found and hands it to the installer. On Windows
 * the installer takes over and the app exits on its own; elsewhere {@link relaunchApp} follows.
 */
export const downloadAndInstall = async (
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> => {
  const update = pending;
  if (!update) {
    throw new IpcError('notFound', 'No update has been checked for.').withDetail({
      key: 'updateUnavailable',
    });
  }
  let downloaded = 0;
  let total: number | undefined;
  const report = (event: DownloadEvent) => {
    if (event.event === 'Started') total = event.data.contentLength;
    else if (event.event === 'Progress') downloaded += event.data.chunkLength;
    else downloaded = total ?? downloaded;
    const progress: DownloadProgress = { downloaded };
    if (total !== undefined) progress.total = total;
    onProgress?.(progress);
  };
  await desktopCall(() => update.downloadAndInstall(report), toUpdateError);
};

/** Restarts MYNK into the version that was just installed. */
export const relaunchApp = (): Promise<void> => desktopCall(() => relaunch(), toUpdateError);

/** Test helper: drops the update handle without closing it. */
export const resetUpdaterForTests = (): void => {
  pending = null;
};
