import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { Channel } from '@tauri-apps/api/core';
import type { ChatRequest, ChatStreamEvent } from '../services/ipcTypes';
import { useChatStream } from './useChatStream';
import { nth } from '../test/assert';
import { stopRust } from '../test/ipc';

const request: ChatRequest = { prompt: 'hi', history: [], lang: 'tr' };

interface Fake {
  requestIds: string[];
  channels: Channel<ChatStreamEvent>[];
  finishers: (() => void)[];
  cancelled: string[];
}

/** Mocks the Rust side: `chat_stream` keeps the channel open until the test finishes it. */
const mockRust = (): Fake => {
  const fake: Fake = { requestIds: [], channels: [], finishers: [], cancelled: [] };
  mockIPC((cmd, args) => {
    const payload = args as Record<string, unknown>;
    if (cmd === 'chat_stream') {
      const channel = payload.channel as Channel<ChatStreamEvent>;
      fake.requestIds.push(payload.requestId as string);
      fake.channels.push(channel);
      return new Promise<void>((resolve) => fake.finishers.push(resolve));
    }
    if (cmd === 'cancel_request') {
      const requestId = payload.requestId as string;
      fake.cancelled.push(requestId);
      const index = fake.requestIds.indexOf(requestId);
      fake.channels[index]?.onmessage({
        type: 'error',
        error: { kind: 'cancelled', message: 'cancelled' },
      });
      fake.finishers[index]?.();
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return fake;
};

const emit = (channel: Channel<ChatStreamEvent>, event: ChatStreamEvent) =>
  act(() => {
    channel.onmessage(event);
    return Promise.resolve();
  });

afterEach(() => {
  stopRust();
});

describe('useChatStream', () => {
  it('accumulates deltas, then exposes usage and the final answer', async () => {
    const fake = mockRust();
    const { result } = renderHook(() => useChatStream());
    let answer: Promise<string | null> = Promise.resolve(null);
    act(() => {
      answer = result.current.send(request);
    });
    expect(result.current.streaming).toBe(true);
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    const channel = nth(fake.channels, 0);

    await emit(channel, { type: 'delta', text: 'Mer' });
    await emit(channel, { type: 'delta', text: 'haba' });
    expect(result.current.text).toBe('Merhaba');
    expect(result.current.streaming).toBe(true);

    await emit(channel, {
      type: 'done',
      usage: { promptTokens: 10, completionTokens: 3, costUsd: 0.0001 },
    });
    await act(async () => {
      nth(fake.finishers, 0)();
      await expect(answer).resolves.toBe('Merhaba');
    });
    expect(result.current.streaming).toBe(false);
    expect(result.current.usage).toEqual({
      promptTokens: 10,
      completionTokens: 3,
      costUsd: 0.0001,
    });
    expect(result.current.error).toBeNull();
  });

  it('cancel() stops streaming, keeps partial text and calls cancel_request', async () => {
    const fake = mockRust();
    const { result } = renderHook(() => useChatStream());
    let answer: Promise<string | null> = Promise.resolve('x');
    act(() => {
      answer = result.current.send(request);
    });
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    await emit(nth(fake.channels, 0), { type: 'delta', text: 'partial' });

    await act(async () => {
      await result.current.cancel();
    });
    expect(fake.cancelled).toHaveLength(1);
    expect(result.current.streaming).toBe(false);
    expect(result.current.cancelled).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.text).toBe('partial');
    await act(async () => {
      await expect(answer).resolves.toBeNull();
    });
  });

  it('exposes provider errors', async () => {
    const fake = mockRust();
    const { result } = renderHook(() => useChatStream());
    let answer: Promise<string | null> = Promise.resolve('x');
    act(() => {
      answer = result.current.send(request);
    });
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    await emit(nth(fake.channels, 0), {
      type: 'error',
      error: {
        kind: 'provider',
        message: 'Your OpenRouter account has insufficient credits',
        status: 402,
      },
    });
    await act(async () => {
      await expect(answer).resolves.toBeNull();
    });
    expect(result.current.error?.kind).toBe('provider');
    expect(result.current.error?.status).toBe(402);
    expect(result.current.cancelled).toBe(false);
  });

  it('a new send cancels the running stream and ignores its late events', async () => {
    const fake = mockRust();
    const { result } = renderHook(() => useChatStream());
    act(() => {
      void result.current.send(request);
    });
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    const first = nth(fake.channels, 0);

    act(() => {
      void result.current.send({ ...request, prompt: 'second' });
    });
    await waitFor(() => expect(fake.channels).toHaveLength(2));
    await waitFor(() => expect(fake.cancelled).toEqual([fake.requestIds[0]]));

    await emit(first, { type: 'delta', text: 'stale' });
    await emit(nth(fake.channels, 1), { type: 'delta', text: 'fresh' });
    expect(result.current.text).toBe('fresh');
    expect(result.current.streaming).toBe(true);
  });

  it('cancels the in-flight stream on unmount', async () => {
    const fake = mockRust();
    const { result, unmount } = renderHook(() => useChatStream());
    act(() => {
      void result.current.send(request);
    });
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    unmount();
    await waitFor(() => expect(fake.cancelled).toHaveLength(1));
  });

  it('settles a stream stopped by unmount as cancelled, with its partial text', async () => {
    const fake = mockRust();
    const { result, unmount } = renderHook(() => useChatStream());
    const onSettled = vi.fn();
    act(() => {
      void result.current.send(request, { onSettled });
    });
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    await emit(nth(fake.channels, 0), { type: 'delta', text: 'half' });

    unmount();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      text: 'half',
      usage: null,
      cancelled: true,
      error: null,
    });
  });
});
