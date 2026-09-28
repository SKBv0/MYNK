import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { Channel } from '@tauri-apps/api/core';
import { analyzeUrl, cancelRequest, chatStream } from './aiService';
import { saveUploadedPreview } from './snapshots';
import { IpcError } from './ipc';
import type { ChatRequest, ChatStreamEvent } from './ipcTypes';
import { stopRust } from '../test/ipc';

type Internals = { invoke: (...args: unknown[]) => Promise<unknown> };
const internals = () =>
  (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

afterEach(() => {
  stopRust();
  vi.restoreAllMocks();
});

const request: ChatRequest = { prompt: 'hi', history: [], lang: 'en' };

/** Mocks `chat_stream`; the test drives the channel. */
const mockStream = () => {
  const state: {
    channel: Channel<ChatStreamEvent> | null;
    finish: () => void;
    args: Record<string, unknown> | null;
  } = {
    channel: null,
    finish: () => undefined,
    args: null,
  };
  const cancelled: string[] = [];
  mockIPC((cmd, args) => {
    const payload = args as Record<string, unknown>;
    if (cmd === 'chat_stream') {
      state.args = payload;
      state.channel = payload.channel as Channel<ChatStreamEvent>;
      return new Promise<void>((resolve) => {
        state.finish = resolve;
      });
    }
    if (cmd === 'cancel_request') {
      cancelled.push(payload.requestId as string);
      state.channel?.onmessage({
        type: 'error',
        error: { kind: 'cancelled', message: 'The request was cancelled.' },
      });
      state.finish();
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return { state, cancelled };
};

describe('chatStream', () => {
  it('forwards deltas and resolves with the full text on done', async () => {
    const { state } = mockStream();
    const events: ChatStreamEvent[] = [];
    const handle = chatStream(request, (e) => events.push(e));
    await vi.waitFor(() => expect(state.channel).not.toBeNull());
    expect(state.args?.requestId).toBe(handle.requestId);
    expect(state.args?.request).toEqual(request);

    state.channel?.onmessage({ type: 'delta', text: 'Hel' });
    state.channel?.onmessage({ type: 'delta', text: 'lo' });
    state.channel?.onmessage({
      type: 'done',
      usage: { promptTokens: 5, completionTokens: 2 },
    });
    state.finish();

    await expect(handle.done).resolves.toBe('Hello');
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'done']);
  });

  it('rejects with the typed error of an error event', async () => {
    const { state } = mockStream();
    const handle = chatStream(request, () => undefined);
    await vi.waitFor(() => expect(state.channel).not.toBeNull());
    state.channel?.onmessage({
      type: 'error',
      error: { kind: 'provider', message: 'rate limit', status: 429 },
    });
    await expect(handle.done).rejects.toMatchObject({ kind: 'provider', status: 429 });
  });

  it('cancel() calls cancel_request with the request id', async () => {
    const { state, cancelled } = mockStream();
    const handle = chatStream(request, () => undefined);
    await vi.waitFor(() => expect(state.channel).not.toBeNull());
    await handle.cancel();
    expect(cancelled).toEqual([handle.requestId]);
    await expect(handle.done).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('rejects when the command itself fails', async () => {
    mockIPC(() => Promise.reject({ kind: 'config', message: 'Invalid request id.' }));
    const events: ChatStreamEvent[] = [];
    const handle = chatStream(request, (e) => events.push(e));
    await expect(handle.done).rejects.toBeInstanceOf(IpcError);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'config' } });
  });

  it('rejects with streamNoResult 5 s after the command ends without a final event', async () => {
    vi.useFakeTimers();
    try {
      const { state } = mockStream();
      const handle = chatStream(request, () => undefined);
      await vi.waitFor(() => expect(state.channel).not.toBeNull());
      let settled = false;
      handle.done.then(
        () => (settled = true),
        () => (settled = true),
      );

      state.finish();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(handle.done).rejects.toMatchObject({
        kind: 'internal',
        detail: { key: 'streamNoResult' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a final event inside the grace period still resolves normally', async () => {
    vi.useFakeTimers();
    try {
      const { state } = mockStream();
      const handle = chatStream(request, () => undefined);
      await vi.waitFor(() => expect(state.channel).not.toBeNull());
      state.channel?.onmessage({ type: 'delta', text: 'late' });
      state.finish();
      await vi.advanceTimersByTimeAsync(2_000);
      state.channel?.onmessage({ type: 'done' });
      await expect(handle.done).resolves.toBe('late');
      // The safety timer was cleared: nothing fires afterwards.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(handle.done).resolves.toBe('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with desktopOnly outside Tauri', async () => {
    const handle = chatStream(request, () => undefined);
    await expect(handle.done).rejects.toMatchObject({ kind: 'desktopOnly' });
  });
});

describe('cancellable requests', () => {
  it('analyzeUrl passes requestId only when given', async () => {
    const seen: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      seen.push({ cmd, ...(args as Record<string, unknown>) });
      return cmd === 'analyze_url' ? { title: 't' } : null;
    });
    await analyzeUrl('https://e.com', 'en');
    await analyzeUrl('https://e.com', 'tr', 'req-1');
    await cancelRequest('req-1');
    expect(seen[0]).toEqual({ cmd: 'analyze_url', url: 'https://e.com', lang: 'en' });
    expect(seen[1]).toEqual({
      cmd: 'analyze_url',
      url: 'https://e.com',
      lang: 'tr',
      requestId: 'req-1',
    });
    expect(seen[2]).toEqual({ cmd: 'cancel_request', requestId: 'req-1' });
  });
});

describe('saveUploadedPreview', () => {
  it('sends the bytes as a raw body with id / ext headers', async () => {
    mockIPC(() => 'upload-x.png');
    const spy = vi.spyOn(internals(), 'invoke');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(saveUploadedPreview('res 1/ü', bytes, 'png')).resolves.toBe('upload-x.png');
    const [cmd, body, options] = spy.mock.calls[0] as [string, unknown, { headers: unknown }];
    expect(cmd).toBe('save_uploaded_preview');
    expect(body).toBe(bytes);
    expect(options.headers).toEqual({
      'x-resource-id': encodeURIComponent('res 1/ü'),
      'x-ext': 'png',
    });
  });

  it('rejects empty images without calling Rust', async () => {
    mockIPC(() => 'never');
    await expect(saveUploadedPreview('r', new Uint8Array(), 'png')).rejects.toMatchObject({
      kind: 'invalidInput',
    });
  });
});
