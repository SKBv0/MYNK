/**
 * Forwards renderer warn/error output to the Rust log file (no devtools in a packaged build).
 * `console.info` is not forwarded; use {@link logInfo} for a line that must survive.
 */
import { error as logError, info as logInfoPlugin, warn as logWarn } from '@tauri-apps/plugin-log';
import { isDesktopRuntime } from '../services/ipc';

const MAX_LINE_CHARS = 2000;

let installed = false;

const describe = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const formatLogLine = (args: unknown[]): string => {
  const line = args.map(describe).join(' ');
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
};

const forward = (send: (message: string) => Promise<void>, args: unknown[]): void => {
  try {
    send(`[renderer] ${formatLogLine(args)}`).catch(() => undefined);
  } catch {
    // The log plugin is unavailable; the console output above is the only record.
  }
};

/** Writes one line straight into the log file, bypassing the console; never throws. */
export const logInfo = (message: string): void => {
  if (!isDesktopRuntime()) return;
  forward(logInfoPlugin, [message]);
};

/** Installs the bridge once. A no-op outside the desktop runtime (browser dev, tests). */
export const installLogBridge = (): void => {
  if (installed || !isDesktopRuntime()) return;
  installed = true;

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    forward(logWarn, args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    forward(logError, args);
  };

  window.addEventListener('error', (event) => {
    forward(logError, ['uncaught:', event.error ?? event.message]);
  });
  window.addEventListener('unhandledrejection', (event) => {
    forward(logError, ['unhandled rejection:', event.reason]);
  });
};

export const __resetLogBridgeForTests = (): void => {
  installed = false;
};
