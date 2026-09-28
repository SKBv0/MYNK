/**
 * Browser bookmark import IPC wrappers. Profiles are addressed by opaque ids; filesystem
 * paths never reach the renderer.
 */
import { call } from './ipc';
import type { DetectedProfile, ImportedBookmark } from './ipcTypes';

/** Chromium family + Firefox profiles on Windows/macOS/Linux; empty list when none. */
export const detectBrowsers = (): Promise<DetectedProfile[]> =>
  call<DetectedProfile[]>('detect_browsers');

/** Reads bookmarks (http/https only) of a profile returned by `detectBrowsers()`. */
export const readBrowserBookmarks = (profileId: string): Promise<ImportedBookmark[]> =>
  call<ImportedBookmark[]>('read_browser_bookmarks', { profileId }, { timeoutMs: 60_000 });
