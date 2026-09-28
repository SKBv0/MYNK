/**
 * Library persistence / export IPC wrappers. Outside the desktop runtime every function
 * throws `IpcError('desktopOnly')`; callers decide on a browser fallback.
 */
import { call } from './ipc';
import type { ExportFormat, LibraryLoadResult } from './ipcTypes';

/** Reads `library.json`; `recoveredFromBackup` is true when `.bak` was read instead. */
export const loadLibrary = async (): Promise<LibraryLoadResult> => {
  const result = await call<LibraryLoadResult | null>('library_load');
  return { json: result?.json ?? null, recoveredFromBackup: result?.recoveredFromBackup === true };
};

/** Atomic write (tmp + fsync + rename) with a `.bak` of the previous file. */
export const saveLibrary = (json: string): Promise<void> => call<void>('library_save', { json });

/** Writes the export into the user's Downloads folder; resolves with the absolute path. */
export const exportLibrary = (
  format: ExportFormat,
  content: string,
  suggestedName: string,
): Promise<string> => call<string>('export_library', { format, content, suggestedName });

/** Reveals an exported file in the OS file manager (export directory only). */
export const revealInFolder = (path: string): Promise<void> =>
  call<void>('reveal_in_folder', { path });
