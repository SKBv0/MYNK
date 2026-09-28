import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Channel } from '@tauri-apps/api/core';
import type { ChatRequest, ChatStreamEvent } from '../services/ipcTypes';
import { GLOBAL_CHAT_KEY } from '../types';
import { mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store } from '../test/app';
import { makeResource } from '../test/fixtures';
import { flushPersistence } from '../store/persistence';
import { nth } from '../test/assert';

let rust: RustMock;

interface Streams {
  requests: ChatRequest[];
  channels: Channel<ChatStreamEvent>[];
  finish: (() => void)[];
}

const TOKIO = makeResource({
  url: 'https://tokio.rs/',
  title: 'Tokio',
  description: 'An async runtime for Rust.',
  summary: ['Work-stealing scheduler.'],
  categoryId: 'development',
});

/** Rust's side of `chat_stream`, driven by the test. */
const streamServer = (mock: RustMock): Streams => {
  const streams: Streams = { requests: [], channels: [], finish: [] };
  mock.on('chat_stream', (args) => {
    streams.requests.push(args.request as ChatRequest);
    streams.channels.push(args.channel as Channel<ChatStreamEvent>);
    return new Promise<void>((resolve) => streams.finish.push(resolve));
  });
  return streams;
};

const emit = (streams: Streams, event: ChatStreamEvent) =>
  act(() => {
    nth(streams.channels, -1).onmessage(event);
  });

const openGlobalChat = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask your library' }));
  return screen.findByRole('dialog', { name: 'Ask your library' });
};

const ask = (root: HTMLElement, label: string, question: string) => {
  const box = within(root).getByLabelText(label);
  fireEvent.change(box, { target: { value: question } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('library chat', () => {
  it('answers in the global dialog and keeps the thread after reopening', async () => {
    const streams = streamServer(rust);
    seedLibrary([TOKIO]);
    await renderApp();

    const dialog = await openGlobalChat();
    ask(dialog, 'Ask your library…', 'What is Tokio?');

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    expect(streams.requests[0]?.system).toContain('[#1] Tokio');
    expect(streams.requests[0]?.prompt).toBe('What is Tokio?');

    emit(streams, { type: 'delta', text: 'It is an async runtime ' });
    expect(await within(dialog).findByText(/It is an async runtime/)).toBeInTheDocument();
    emit(streams, { type: 'delta', text: '[#1].' });
    emit(streams, { type: 'done', usage: { promptTokens: 900, completionTokens: 12 } });

    await waitFor(() => expect(store().chats[GLOBAL_CHAT_KEY]).toHaveLength(2));
    const answer = nth(store().chats[GLOBAL_CHAT_KEY] ?? [], 1);
    expect(answer).toMatchObject({ role: 'assistant', sources: [TOKIO.id] });
    expect(answer.usage).toMatchObject({ promptTokens: 900, provider: 'ollama' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Ask your library' })).toBeNull(),
    );
    const reopened = await openGlobalChat();
    expect(within(reopened).getByText('What is Tokio?')).toBeInTheDocument();
    expect(within(reopened).getByText(/It is an async runtime/)).toBeInTheDocument();

    await flushPersistence();
    const saved = rust.argsOf('library_save').at(-1)?.json as string;
    expect(saved).toContain('What is Tokio?');
  });

  it('opens the cited bookmark when the citation chip is clicked', async () => {
    const streams = streamServer(rust);
    seedLibrary([TOKIO]);
    await renderApp();

    const dialog = await openGlobalChat();
    ask(dialog, 'Ask your library…', 'Which runtime did I save?');
    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'delta', text: 'You saved [#1].' });
    emit(streams, { type: 'done' });

    await waitFor(() => expect(store().chats[GLOBAL_CHAT_KEY]).toHaveLength(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Open source 1' }));

    await waitFor(() => expect(store().selectedResourceId).toBe(TOKIO.id));
    expect(screen.queryByRole('dialog', { name: 'Ask your library' })).toBeNull();
    expect(
      await screen.findByRole('complementary', { name: 'Bookmark details' }),
    ).toBeInTheDocument();
  });

  it('keeps the per-bookmark conversation separate and scoped to that page', async () => {
    const streams = streamServer(rust);
    seedLibrary([TOKIO, makeResource({ title: 'Other' })]);
    await renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Tokio' }));
    const panel = await screen.findByRole('complementary', { name: 'Bookmark details' });
    ask(panel, 'Ask about this bookmark…', 'Does it have a scheduler?');

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    expect(streams.requests[0]?.system).toContain('ONE saved bookmark');
    expect(streams.requests[0]?.system).toContain('Work-stealing scheduler.');

    emit(streams, { type: 'delta', text: 'Yes, a work-stealing one.' });
    emit(streams, { type: 'done' });

    await waitFor(() => expect(store().chats[TOKIO.id]).toHaveLength(2));
    expect(store().chats[GLOBAL_CHAT_KEY]).toBeUndefined();
  });

  it('keeps the question box pinned in the details panel and folds the thread away', async () => {
    const streams = streamServer(rust);
    seedLibrary([TOKIO]);
    await renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Tokio' }));
    const panel = await screen.findByRole('complementary', { name: 'Bookmark details' });
    // No conversation yet: only the box, no empty-thread placeholder taking up the panel.
    expect(within(panel).getByLabelText('Ask about this bookmark…')).toBeInTheDocument();
    expect(
      within(panel).queryByText(
        'Questions are answered from the saved description and key points.',
      ),
    ).toBeNull();
    expect(within(panel).queryByRole('button', { name: /conversation/ })).toBeNull();

    ask(panel, 'Ask about this bookmark…', 'Does it have a scheduler?');
    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'delta', text: 'Yes.' });
    emit(streams, { type: 'done' });
    await waitFor(() => expect(within(panel).getByText('Yes.')).toBeInTheDocument());
    expect(within(panel).getByText('2 messages')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Hide conversation' }));
    expect(within(panel).queryByText('Yes.')).toBeNull();
    expect(within(panel).getByLabelText('Ask about this bookmark…')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show conversation' }));
    expect(within(panel).getByText('Yes.')).toBeInTheDocument();
  });

  it('clears a conversation on request', async () => {
    const streams = streamServer(rust);
    seedLibrary([TOKIO]);
    await renderApp();

    const dialog = await openGlobalChat();
    ask(dialog, 'Ask your library…', 'Anything?');
    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'delta', text: 'Something.' });
    emit(streams, { type: 'done' });
    await waitFor(() => expect(store().chats[GLOBAL_CHAT_KEY]).toHaveLength(2));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear conversation' }));
    await waitFor(() => expect(store().chats[GLOBAL_CHAT_KEY]).toBeUndefined());
    expect(within(dialog).getByText('Ask your library', { selector: 'p' })).toBeInTheDocument();
  });

  it('deleting a bookmark also deletes its conversation', async () => {
    seedLibrary([TOKIO]);
    store().appendChatMessage(TOKIO.id, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      createdAt: 1,
    });
    await renderApp();

    store().removeResources([TOKIO.id]);
    await waitFor(() => expect(store().chats[TOKIO.id]).toBeUndefined());
  });
});
