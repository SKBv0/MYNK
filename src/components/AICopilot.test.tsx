import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { Channel } from '@tauri-apps/api/core';
import type { AISettings, ChatRequest, ChatStreamEvent } from '../services/ipcTypes';
import { useAppStore } from '../store';
import { GLOBAL_CHAT_KEY } from '../types';
import AICopilot from './AICopilot';
import { nth } from '../test/assert';
import { stopRust } from '../test/ipc';
import { makeResource } from '../test/fixtures';

const initial = useAppStore.getState();

const settings: AISettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3',
  openrouterModel: '',
  hasOpenrouterApiKey: false,
  allowPrivateNetwork: false,
  embeddingModel: '',
};

interface FakeRust {
  requests: ChatRequest[];
  channels: Channel<ChatStreamEvent>[];
  cancelled: string[];
}

/** Rust side of `chat_stream`: the test drives the channel; cancel ends it with `cancelled`. */
const mockRust = (): FakeRust => {
  const fake: FakeRust = { requests: [], channels: [], cancelled: [] };
  const finishers: (() => void)[] = [];
  const ids: string[] = [];
  mockIPC((cmd, args) => {
    const payload = args as Record<string, unknown>;
    if (cmd === 'get_ai_settings') return settings;
    if (cmd === 'chat_stream') {
      fake.requests.push(payload.request as ChatRequest);
      fake.channels.push(payload.channel as Channel<ChatStreamEvent>);
      ids.push(payload.requestId as string);
      return new Promise<void>((resolve) => finishers.push(resolve));
    }
    if (cmd === 'cancel_request') {
      const id = payload.requestId as string;
      fake.cancelled.push(id);
      const index = ids.indexOf(id);
      fake.channels[index]?.onmessage({
        type: 'error',
        error: { kind: 'cancelled', message: 'cancelled' },
      });
      finishers[index]?.();
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return fake;
};

const emit = (fake: FakeRust, event: ChatStreamEvent) =>
  act(() => {
    nth(fake.channels, -1).onmessage(event);
  });

const ask = (question: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: question } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

const thread = () => useAppStore.getState().chats[GLOBAL_CHAT_KEY] ?? [];

beforeAll(() => {
  // jsdom has no scrolling.
  Element.prototype.scrollTo = vi.fn();
});

beforeEach(() => {
  useAppStore.setState(initial, true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stopRust();
  vi.restoreAllMocks();
});

describe('AICopilot streaming', () => {
  it('shows the answer as it streams, then stores it with its usage', async () => {
    const fake = mockRust();
    useAppStore.setState({
      resources: ['alpha', 'beta', 'gamma'].map((name) =>
        makeResource({ title: `${name} notes`, url: `https://${name}.example.com/` }),
      ),
    });
    render(<AICopilot />);
    ask('What did I save about Rust?');

    await waitFor(() => expect(fake.channels).toHaveLength(1));
    expect(fake.requests[0]?.prompt).toBe('What did I save about Rust?');
    // Nothing matches, so the newest come first and the oldest fixture is the third excerpt.
    expect(fake.requests[0]?.system).toMatch(/^\[#3\] gamma notes\b.*\bgamma\.example\.com\b/m);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    emit(fake, { type: 'delta', text: 'Tokio is ' });
    expect(screen.getByText('Tokio is')).toBeInTheDocument();
    emit(fake, { type: 'delta', text: 'an async runtime.' });
    expect(screen.getByText('Tokio is an async runtime.')).toBeInTheDocument();
    expect(thread().filter((m) => m.role === 'assistant')).toHaveLength(0);

    emit(fake, { type: 'done', usage: { promptTokens: 1200, completionTokens: 34 } });

    await waitFor(() => expect(thread()).toHaveLength(2));
    const answer = nth(thread(), 1);
    expect(answer).toMatchObject({
      role: 'assistant',
      content: 'Tokio is an async runtime.',
      usage: { promptTokens: 1200, completionTokens: 34, provider: 'ollama', model: 'llama3' },
    });
    expect(answer.partial).toBeUndefined();
    expect(screen.getByText('1,234 tokens · local · free')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('stop keeps the partial answer and marks it', async () => {
    const fake = mockRust();
    render(<AICopilot />);
    ask('Summarize everything');

    await waitFor(() => expect(fake.channels).toHaveLength(1));
    emit(fake, { type: 'delta', text: 'First half' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(fake.cancelled).toHaveLength(1));
    await waitFor(() => expect(thread()).toHaveLength(2));
    expect(thread()[1]).toMatchObject({ content: 'First half', partial: true });
    expect(screen.getByText('Stopped (partial answer)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it('reports an error with a toast and offers a retry', async () => {
    const fake = mockRust();
    render(<AICopilot />);
    ask('Hello?');

    await waitFor(() => expect(fake.channels).toHaveLength(1));
    emit(fake, { type: 'delta', text: 'Hel' });
    emit(fake, { type: 'error', error: { kind: 'network', message: 'offline' } });

    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(useAppStore.getState().toasts[0]?.type).toBe('error');
    expect(thread()).toHaveLength(1);
    // The toast is written to the store at once; the button appears with the next render.
    fireEvent.click(await screen.findByRole('button', { name: 'Retry last question' }));

    await waitFor(() => expect(fake.channels).toHaveLength(2));
    expect(fake.requests[1]?.prompt).toBe('Hello?');
    expect(fake.requests[1]?.history).toEqual([]);
  });
});

describe('AICopilot keeps answers it cannot finish', () => {
  const retryFromToast = () =>
    act(() => {
      useAppStore.getState().toasts[0]?.action?.run();
    });

  it('keeps the partial answer when the chat goes away mid-answer', async () => {
    const fake = mockRust();
    const { unmount } = render(<AICopilot />);
    ask('Summarize everything');
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    emit(fake, { type: 'delta', text: 'First half' });

    unmount();

    await waitFor(() => expect(fake.cancelled).toHaveLength(1));
    expect(thread()).toHaveLength(2);
    expect(thread()[1]).toMatchObject({ content: 'First half', partial: true });
  });

  it('ignores the toast retry while a newer question is being answered', async () => {
    const fake = mockRust();
    render(<AICopilot />);
    ask('Hello?');
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    emit(fake, { type: 'error', error: { kind: 'network', message: 'offline' } });
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));

    ask('Second question');
    await waitFor(() => expect(fake.channels).toHaveLength(2));
    emit(fake, { type: 'delta', text: 'Answer in progress' });
    retryFromToast();
    // Long enough for a retry to reach the stream if it were started.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(fake.channels).toHaveLength(2);
    expect(fake.cancelled).toEqual([]);
    expect(screen.getByText('Answer in progress')).toBeInTheDocument();
  });

  it('asks a failed question again below a newer answer', async () => {
    const fake = mockRust();
    render(<AICopilot />);
    ask('Hello?');
    await waitFor(() => expect(fake.channels).toHaveLength(1));
    emit(fake, { type: 'error', error: { kind: 'network', message: 'offline' } });
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));

    ask('Second question');
    await waitFor(() => expect(fake.channels).toHaveLength(2));
    emit(fake, { type: 'delta', text: 'Second answer' });
    emit(fake, { type: 'done' });
    await waitFor(() => expect(thread()).toHaveLength(3));
    retryFromToast();

    await waitFor(() => expect(fake.channels).toHaveLength(3));
    expect(fake.requests[2]?.prompt).toBe('Hello?');
    expect(fake.requests[2]?.history.map((turn) => turn.content)).toEqual([
      'Hello?',
      'Second question',
      'Second answer',
    ]);
    expect(thread().map((m) => m.content)).toEqual([
      'Hello?',
      'Second question',
      'Second answer',
      'Hello?',
    ]);
  });
});

describe('AICopilot scrolling and input', () => {
  it('follows the stream only while the reader is at the bottom', async () => {
    const fake = mockRust();
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    render(<AICopilot />);
    ask('Write a long answer');
    await waitFor(() => expect(fake.channels).toHaveLength(1));

    emit(fake, { type: 'delta', text: 'First part. ' });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: expect.any(Number), behavior: 'auto' });

    const log = screen.getByRole('textbox').closest('form')?.previousElementSibling as HTMLElement;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(log, 'scrollTop', { configurable: true, value: 200 });
    fireEvent.scroll(log);
    scrollTo.mockClear();

    emit(fake, { type: 'delta', text: 'Second part.' });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('grows the question box with its content', () => {
    mockRust();
    render(<AICopilot />);
    const box = screen.getByRole('textbox');
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 96 });
    fireEvent.change(box, { target: { value: 'line 1\nline 2\nline 3' } });
    expect(box.style.height).toBe('96px');
  });
});
