import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Channel } from '@tauri-apps/api/core';
import type { ChatRequest, ChatStreamEvent } from '../services/ipcTypes';
import { mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { makeResource } from '../test/fixtures';
import { nth } from '../test/assert';

let rust: RustMock;

interface Streams {
  requests: ChatRequest[];
  channels: Channel<ChatStreamEvent>[];
}

const TWO = [
  makeResource({ url: 'https://a.example.com/', title: 'Alpha', summary: ['One.'] }),
  makeResource({ url: 'https://b.example.com/', title: 'Beta', summary: ['Two.'] }),
];

const streamServer = (mock: RustMock): Streams => {
  const streams: Streams = { requests: [], channels: [] };
  mock.on('chat_stream', (args) => {
    streams.requests.push(args.request as ChatRequest);
    streams.channels.push(args.channel as Channel<ChatStreamEvent>);
    return new Promise<void>(() => undefined);
  });
  return streams;
};

const emit = (streams: Streams, event: ChatStreamEvent) =>
  act(() => {
    nth(streams.channels, -1).onmessage(event);
  });

const selectAll = async () => {
  fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
  return screen.findByRole('toolbar', { name: 'Selection actions' });
};

const openSynthesis = async () => {
  const dock = await selectAll();
  fireEvent.click(within(dock).getByRole('button', { name: 'Create report' }));
  return screen.findByRole('dialog', { name: 'Combined report' });
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('synthesis', () => {
  it('is offered only once bookmarks are selected', async () => {
    seedLibrary(TWO);
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const disabled = await screen.findByRole('menuitem', {
      name: /Create a report from the selection/,
    });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).toHaveAccessibleDescription(
      'Select bookmarks first (checkbox on a card or Ctrl+A)',
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await selectAll();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const enabled = await screen.findByRole('menuitem', {
      name: 'Create a report from the selection',
    });
    expect(enabled).not.toHaveAttribute('aria-disabled');
  });

  it('explains what to do when it is opened with nothing selected', async () => {
    seedLibrary(TWO);
    await renderApp();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog');
    const input = within(palette).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Create a report' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog', { name: 'Combined report' });
    expect(
      within(dialog).getByText('Select bookmarks first (checkbox on each card or Ctrl+A).'),
    ).toBeInTheDocument();
    expect(rust.countOf('chat_stream')).toBe(0);
  });

  it('streams a report for the selected bookmarks and copies it with its sources', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const streams = streamServer(rust);
    seedLibrary(TWO);
    await renderApp();
    const dialog = await openSynthesis();

    expect(
      within(dialog).getByText(
        'Summarize the shared topics of the 2 selected bookmarks in one report.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    expect(streams.requests[0]?.prompt).toContain('Synthesize these 2 bookmarks');
    expect(streams.requests[0]?.prompt).toContain('[#1] Alpha');
    expect(streams.requests[0]?.prompt).toContain('[#2] Beta');

    emit(streams, { type: 'delta', text: '# Examples\n\nBoth are examples [#2].' });
    expect(await within(dialog).findByRole('heading', { name: 'Examples' })).toBeInTheDocument();
    emit(streams, { type: 'done' });

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Copy report' })).toBeInTheDocument(),
    );
    expect(within(dialog).queryByText('Stopped (partial report)')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy report' }));
    await waitForToast('Report copied.');
    expect(writeText).toHaveBeenCalledWith(
      [
        '# Examples',
        '',
        'Both are examples [#2].',
        '',
        '## Sources',
        '',
        '1. Alpha <https://a.example.com/>',
        '2. Beta <https://b.example.com/>',
      ].join('\n'),
    );
  });

  it('opens the cited bookmark when a citation in the report is clicked', async () => {
    const streams = streamServer(rust);
    seedLibrary(TWO);
    await renderApp();
    const dialog = await openSynthesis();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'delta', text: 'Beta is the second one [#2].' });
    emit(streams, { type: 'done' });

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open source 2' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Combined report' })).toBeNull(),
    );
    expect(store().selectedResourceId).toBe(nth(TWO, 1).id);
  });

  it('reads only as many bookmarks as one report fits and says so', async () => {
    const streams = streamServer(rust);
    seedLibrary(
      Array.from({ length: 52 }, (_, i) =>
        makeResource({ url: `https://s${i}.example.com/`, title: `Site ${i}` }),
      ),
    );
    await renderApp();
    const dialog = await openSynthesis();

    expect(
      within(dialog).getByText(
        'A report can use up to 50 bookmarks. The first 50 of the 52 selected bookmarks are used.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));

    await waitFor(() => expect(streams.requests).toHaveLength(1));
    expect(streams.requests[0]?.prompt).toContain('Synthesize these 50 bookmarks');
  });

  it('stopping keeps what was written so far and marks it as partial', async () => {
    const streams = streamServer(rust);
    seedLibrary(TWO);
    await renderApp();
    const dialog = await openSynthesis();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'delta', text: '## Half a report' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(rust.countOf('cancel_request')).toBe(1));
    expect(await within(dialog).findByText('Stopped (partial report)')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Half a report' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create again' })).toBeInTheDocument();
  });

  it('asks before closing while the report is still being written', async () => {
    const streams = streamServer(rust);
    seedLibrary(TWO);
    await renderApp();
    const dialog = await openSynthesis();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'delta', text: '## Half a report' });
    fireEvent.keyDown(document.body, { key: 'Escape' });

    const confirm = await screen.findByRole('alertdialog', { name: 'Stop the answer?' });
    expect(screen.getByRole('dialog', { name: 'Combined report' })).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Stop and close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Combined report' })).toBeNull(),
    );
  });

  it('reports a failed synthesis and leaves the selection untouched', async () => {
    const streams = streamServer(rust);
    seedLibrary(TWO);
    await renderApp();
    const dialog = await openSynthesis();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));

    await waitFor(() => expect(streams.channels).toHaveLength(1));
    emit(streams, { type: 'error', error: { kind: 'provider', message: 'overloaded' } });

    await waitForToast('Could not create the report');
    expect(store().batchSelectedIds).toHaveLength(2);
    expect(
      await within(dialog).findByRole('button', { name: 'Create report' }),
    ).toBeInTheDocument();
  });

  it('closes without starting anything', async () => {
    seedLibrary(TWO);
    await renderApp();
    const dialog = await openSynthesis();
    // The dialog header and the body both offer "Close"; use the one in the body.
    const closeButtons = within(dialog).getAllByRole('button', { name: 'Close' });
    fireEvent.click(nth(closeButtons, -1));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Combined report' })).toBeNull(),
    );
    expect(rust.countOf('chat_stream')).toBe(0);
  });
});
