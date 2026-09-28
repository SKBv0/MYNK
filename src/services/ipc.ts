/**
 * Core IPC helper. Every Tauri command goes through `call()`: outside the desktop runtime it
 * rejects with `IpcError('desktopOnly')`, rejected payloads become typed `IpcError`s, and an
 * optional client-side timeout rejects with `IpcError('timeout')`. No wrapper swallows errors.
 */
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import type { AppErrorCode, AppErrorKind, AppErrorPayload } from './ipcTypes';

const ERROR_KINDS: readonly AppErrorKind[] = [
  'desktopOnly',
  'config',
  'invalidInput',
  'network',
  'timeout',
  'blockedAddress',
  'provider',
  'parse',
  'keyring',
  'storage',
  'notFound',
  'cancelled',
  'internal',
];

/** Errors Rust refines with a code, so the user sees a translated sentence. */
export const ERROR_CODES: readonly AppErrorCode[] = [
  'modelMissing',
  'notChatModel',
  'ollamaUnreachable',
  'hostNotFound',
  'tlsCertificate',
  'tlsHandshake',
  'browserLocked',
  'inputTooLong',
];

/** Detail keys for frontend-authored errors; `lib/errors.ts` translates them for the user. */
export type ErrorDetailKey =
  | 'futureVersion'
  | 'corruptLibrary'
  | 'streamNoResult'
  | 'keywordsNotJson'
  | 'keywordsInvalidJson'
  | 'keywordsNoList'
  | 'updateSignature'
  | 'updateUnavailable';

export interface ErrorDetail {
  key: ErrorDetailKey;
  vars?: Record<string, string | number>;
}

export class IpcError extends Error {
  kind: AppErrorKind;
  status?: number;
  /** Translation reference for a frontend-authored detail (see `lib/errors.ts`). */
  detail?: ErrorDetail;
  /** Backend-set refinement of `kind` (`AppErrorPayload.code`), with the model it names. */
  code?: AppErrorCode;
  model?: string;

  constructor(kind: AppErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'IpcError';
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
  }

  /** Marks the message as frontend-authored, so the user sees the translated text. */
  withDetail(detail: ErrorDetail): this {
    this.detail = detail;
    return this;
  }
}

export const isDesktopRuntime = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const isErrorKind = (value: unknown): value is AppErrorKind =>
  typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);

const isErrorCode = (value: unknown): value is AppErrorCode =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);

const isAppErrorPayload = (value: unknown): value is AppErrorPayload => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isErrorKind(candidate.kind) && typeof candidate.message === 'string';
};

export const toIpcError = (e: unknown): IpcError => {
  if (e instanceof IpcError) return e;
  if (isAppErrorPayload(e)) {
    const error = new IpcError(
      e.kind,
      e.message,
      typeof e.status === 'number' ? e.status : undefined,
    );
    if (isErrorCode(e.code)) {
      error.code = e.code;
      if (typeof e.model === 'string') error.model = e.model;
    }
    return error;
  }
  if (typeof e === 'string') return new IpcError('internal', e);
  if (e instanceof Error) return new IpcError('internal', e.message);
  return new IpcError('internal', 'Unknown error');
};

export const desktopOnlyError = (): IpcError =>
  new IpcError('desktopOnly', 'This feature is available only in the MYNK desktop app.');

/** Runs a non-`invoke` Tauri API (events, plugins) under the same contract as {@link call}. */
export const desktopCall = async <T>(
  run: () => Promise<T>,
  mapError: (error: unknown) => IpcError = toIpcError,
): Promise<T> => {
  if (!isDesktopRuntime()) throw desktopOnlyError();
  try {
    return await run();
  } catch (error) {
    throw mapError(error);
  }
};

export interface CallOptions {
  timeoutMs?: number;
  /** Request headers (used with a raw `Uint8Array` / `ArrayBuffer` body). */
  headers?: Record<string, string>;
}

export async function call<T>(cmd: string, args?: InvokeArgs, opts?: CallOptions): Promise<T> {
  if (!isDesktopRuntime()) {
    throw desktopOnlyError();
  }

  const request = opts?.headers
    ? invoke<T>(cmd, args, { headers: opts.headers })
    : invoke<T>(cmd, args);
  const timeoutMs = opts?.timeoutMs;

  if (!timeoutMs || timeoutMs <= 0) {
    try {
      return await request;
    } catch (e) {
      throw toIpcError(e);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new IpcError('timeout', `Command "${cmd}" timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([request, timeout]);
  } catch (e) {
    throw toIpcError(e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
