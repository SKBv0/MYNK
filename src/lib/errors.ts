/** Central error reporting: `reportError` logs every caught error and shows a translated toast. */
import { toIpcError, type IpcError } from '../services/ipc';
import type { AppErrorKind } from '../services/ipcTypes';
import { getT, useAppStore } from '../store';
import type { Toast } from '../types';
import type { TranslationSchema } from '../translations';
import { fmt } from './text';

/** Kinds whose raw backend message is worth showing after the translated text. */
const DETAIL_KINDS = new Set<AppErrorKind>(['provider', 'network']);

/** A provider detail that only restates the HTTP status the translated text already names. */
const STATUS_ONLY_DETAIL = /^[^:]*\bHTTP \d{3}[.:]?$/;

export const errorKind = (error: unknown): AppErrorKind => toIpcError(error).kind;

/** Translated detail for a frontend-authored error, else the raw message for `DETAIL_KINDS`. */
const detailText = (error: IpcError, t: TranslationSchema): string => {
  if (error.detail) return fmt(t.errors.details[error.detail.key], error.detail.vars ?? {});
  if (!DETAIL_KINDS.has(error.kind)) return '';
  const raw = error.message?.trim() ?? '';
  return STATUS_ONLY_DETAIL.test(raw) ? '' : raw;
};

/** Translated, user-facing message for any thrown value. */
export const errorMessage = (error: unknown, t: TranslationSchema = getT()): string => {
  const ipcError = toIpcError(error);
  // A Rust-assigned code carries its own full sentence, more specific than the kind's generic text.
  if (ipcError.code) {
    return fmt(t.errors.codes[ipcError.code], { model: ipcError.model ?? '' });
  }
  let base: string = t.errors[ipcError.kind] ?? t.errors.internal;
  if (ipcError.kind === 'provider' && ipcError.status) {
    base = fmt(t.errors.providerStatus, { status: ipcError.status });
  }
  const detail = detailText(ipcError, t);
  if (detail && detail !== base) {
    return `${base} (${detail.length > 140 ? `${detail.slice(0, 140)}…` : detail})`;
  }
  return base;
};

export interface ReportOptions {
  /** Show a toast (default true). */
  toast?: boolean;
  /** Short context shown before the message. */
  prefix?: string;
  action?: Toast['action'];
}

export const reportError = (error: unknown, context: string, options: ReportOptions = {}): void => {
  console.error(`[MYNK] ${context}:`, error);
  if (options.toast === false) return;
  const message = errorMessage(error);
  useAppStore
    .getState()
    .pushToast(options.prefix ? `${options.prefix}: ${message}` : message, 'error', {
      action: options.action,
    });
};

/** Copies text to the clipboard, reporting success or failure with a toast. */
export const copyToClipboard = async (text: string, successMessage: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    useAppStore.getState().pushToast(successMessage, 'success');
    return true;
  } catch (error) {
    reportError(error, 'clipboard', { prefix: getT().errors.clipboard });
    return false;
  }
};
