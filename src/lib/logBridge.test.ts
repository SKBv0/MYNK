import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pluginLog = vi.hoisted(() => ({
  info: vi.fn((_message: string) => Promise.resolve()),
  warn: vi.fn((_message: string) => Promise.resolve()),
  error: vi.fn((_message: string) => Promise.resolve()),
}));
const runtime = vi.hoisted(() => ({ desktop: true }));

vi.mock('@tauri-apps/plugin-log', () => pluginLog);
vi.mock('../services/ipc', () => ({ isDesktopRuntime: () => runtime.desktop }));

import { __resetLogBridgeForTests, formatLogLine, installLogBridge, logInfo } from './logBridge';

describe('logBridge', () => {
  const originalWarn = console.warn;
  const originalError = console.error;

  beforeEach(() => {
    __resetLogBridgeForTests();
    pluginLog.info.mockClear();
    pluginLog.warn.mockClear();
    pluginLog.error.mockClear();
    console.warn = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    runtime.desktop = true;
  });

  it('forwards console warnings and errors to the log plugin, keeping console output', () => {
    const consoleError = console.error;
    installLogBridge();
    console.warn('[MYNK] careful', { a: 1 });
    console.error('[MYNK] broke', new Error('boom'));

    expect(pluginLog.warn).toHaveBeenCalledWith('[renderer] [MYNK] careful {"a":1}');
    expect(pluginLog.error).toHaveBeenCalledTimes(1);
    expect(pluginLog.error.mock.calls[0]?.[0]).toContain('boom');
    expect(consoleError).toHaveBeenCalled();
  });

  it('does nothing outside the desktop runtime', () => {
    runtime.desktop = false;
    const before = console.warn;
    installLogBridge();
    expect(console.warn).toBe(before);
  });

  it('writes a log line straight into the log file, without touching the console', () => {
    logInfo('agent inbox: 2 entries from cli');

    expect(pluginLog.info).toHaveBeenCalledWith('[renderer] agent inbox: 2 entries from cli');
    expect(console.warn).not.toHaveBeenCalled();
    expect(pluginLog.warn).not.toHaveBeenCalled();
  });

  it('skips the log line in a browser build and never throws', async () => {
    runtime.desktop = false;
    logInfo('nothing to forward');
    expect(pluginLog.info).not.toHaveBeenCalled();

    runtime.desktop = true;
    pluginLog.info.mockImplementationOnce(() => Promise.reject(new Error('no plugin')));
    expect(() => logInfo('still fine')).not.toThrow();
    await Promise.resolve();
  });

  it('never throws when the plugin rejects', async () => {
    pluginLog.error.mockImplementationOnce(() => Promise.reject(new Error('no plugin')));
    installLogBridge();
    expect(() => console.error('x')).not.toThrow();
    await Promise.resolve();
  });

  it('caps very long lines and survives circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatLogLine(['x'.repeat(5000)]).length).toBeLessThanOrEqual(2001);
    expect(() => formatLogLine([circular])).not.toThrow();
  });
});
