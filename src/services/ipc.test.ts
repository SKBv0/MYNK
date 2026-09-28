import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { call, IpcError, isDesktopRuntime, toIpcError } from './ipc';
import { openExternalUrl, parseKeywordResponse, setOpenRouterApiKey } from './aiService';
import { loadLibrary } from './library';
import { snapshotSrc } from './snapshots';
import { stopRust } from '../test/ipc';

afterEach(stopRust);

describe('toIpcError', () => {
  it('maps AppErrorPayload objects', () => {
    const err = toIpcError({ kind: 'provider', message: 'Unauthorized', status: 401 });
    expect(err).toBeInstanceOf(IpcError);
    expect(err.kind).toBe('provider');
    expect(err.status).toBe(401);
    expect(err.message).toBe('Unauthorized');
  });

  it('maps strings, Errors and unknown values to internal', () => {
    expect(toIpcError('boom').kind).toBe('internal');
    expect(toIpcError(new Error('x')).message).toBe('x');
    expect(toIpcError(42).kind).toBe('internal');
    expect(toIpcError({ kind: 'nope', message: 'm' }).kind).toBe('internal');
  });

  it('returns IpcError instances unchanged', () => {
    const original = new IpcError('timeout', 't');
    expect(toIpcError(original)).toBe(original);
  });
});

describe('call', () => {
  it('rejects with desktopOnly outside Tauri', async () => {
    stopRust();
    expect(isDesktopRuntime()).toBe(false);
    await expect(call('get_ai_settings')).rejects.toMatchObject({ kind: 'desktopOnly' });
    await expect(loadLibrary()).rejects.toMatchObject({ kind: 'desktopOnly' });
    await expect(openExternalUrl('https://example.com')).rejects.toMatchObject({
      kind: 'desktopOnly',
    });
  });

  it('passes camelCase args and converts rejected payloads', async () => {
    const seen: Array<{ cmd: string; args: unknown }> = [];
    mockIPC((cmd, args) => {
      seen.push({ cmd, args });
      if (cmd === 'set_openrouter_api_key') {
        return undefined;
      }
      throw { kind: 'keyring', message: 'locked' };
    });

    await setOpenRouterApiKey('sk-test');
    expect(seen[0]).toEqual({ cmd: 'set_openrouter_api_key', args: { apiKey: 'sk-test' } });

    await expect(call('get_ai_settings')).rejects.toMatchObject({
      kind: 'keyring',
      message: 'locked',
    });
  });

  it('times out with IpcError(timeout)', async () => {
    mockIPC(() => new Promise(() => undefined));
    await expect(call('slow', {}, { timeoutMs: 10 })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('openExternalUrl', () => {
  it('rejects non-http schemes before invoking', async () => {
    const seen: string[] = [];
    mockIPC((cmd) => {
      seen.push(cmd);
    });
    await expect(openExternalUrl('javascript:alert(1)')).rejects.toMatchObject({
      kind: 'invalidInput',
    });
    await expect(openExternalUrl('file:///C:/secret.txt')).rejects.toMatchObject({
      kind: 'invalidInput',
    });
    expect(seen).toEqual([]);
    await openExternalUrl('example.com/path');
    expect(seen).toEqual(['open_external_url']);
  });
});

describe('parseKeywordResponse', () => {
  it('parses object, array and fenced responses', () => {
    expect(parseKeywordResponse('{"keywords": ["Rust", "tauri", "rust"]}')).toEqual([
      'rust',
      'tauri',
    ]);
    expect(parseKeywordResponse('```json\n["a", "b"]\n```')).toEqual(['a', 'b']);
    expect(parseKeywordResponse('Sure! {"tags": "x, y"} hope it helps')).toEqual(['x', 'y']);
  });

  it('throws IpcError(parse) on garbage', () => {
    expect(() => parseKeywordResponse('no json here')).toThrow(IpcError);
  });
});

describe('snapshotSrc', () => {
  it('returns empty string before init', () => {
    expect(snapshotSrc('abc.png')).toBe('');
  });
});
