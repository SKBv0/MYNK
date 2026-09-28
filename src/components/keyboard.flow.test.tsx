import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mockRust, stopRust } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store } from '../test/app';
import { makeResource } from '../test/fixtures';
import { nth } from '../test/assert';

const TOKIO = makeResource({ url: 'https://tokio.rs/', title: 'Tokio runtime' });
const REACT = makeResource({ url: 'https://react.dev/', title: 'React docs' });

const openPalette = async () => {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const dialog = await screen.findByRole('dialog');
  return { dialog, input: within(dialog).getByRole('combobox') };
};

const activeOption = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true');

beforeEach(() => {
  resetApp();
  mockRust();
});

afterEach(() => {
  stopRust();
});

describe('command palette', () => {
  it('opens with Ctrl+K, moves with the arrow keys and runs with Enter', async () => {
    seedLibrary([TOKIO, REACT]);
    await renderApp();
    const { dialog, input } = await openPalette();

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(activeOption(dialog)).toHaveTextContent('Add bookmark');
    expect(input).toHaveAttribute('aria-activedescendant', 'palette-item-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(dialog)).toHaveTextContent('Import bookmarks');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(dialog)).toHaveTextContent('Add bookmark');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Add bookmark' })).toBeInTheDocument();
    expect(store().activeModal).toBe('addLink');
  });

  it('finds bookmarks by name and opens the one chosen with Enter', async () => {
    seedLibrary([TOKIO, REACT]);
    await renderApp();
    const { dialog, input } = await openPalette();

    fireEvent.change(input, { target: { value: 'tokio' } });
    await waitFor(() => expect(within(dialog).getByText('Bookmarks')).toBeInTheDocument());
    expect(within(dialog).getByText('Tokio runtime')).toBeInTheDocument();
    expect(within(dialog).queryByText('React docs')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(store().selectedResourceId).toBe(TOKIO.id));
    expect(store().activeModal).toBeNull();
  });

  it('says so when nothing matches and closes again on Ctrl+K', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const { dialog, input } = await openPalette();

    fireEvent.change(input, { target: { value: 'zzzz' } });
    expect(
      await within(dialog).findByText('No matching commands or bookmarks.'),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(store().activeModal).toBeNull());
  });

  it('scrolls the highlighted option into view as the arrow keys move it', async () => {
    seedLibrary([TOKIO, REACT]);
    await renderApp();
    const { dialog, input } = await openPalette();

    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(activeOption(dialog)).toHaveTextContent('Import bookmarks');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.instances[0]).toBe(activeOption(dialog));
    scrollIntoView.mockRestore();
  });

  it('matches Turkish command names typed without their diacritics', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    act(() => {
      store().setLang('tr');
    });
    const { dialog, input } = await openPalette();

    fireEvent.change(input, { target: { value: 'ozeti' } });
    expect(
      await within(dialog).findByText('Özeti olmayan yer imlerini analiz et'),
    ).toBeInTheDocument();
  });

  it('runs an Alt+letter shortcut while the user is typing', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    const { input } = await openPalette();

    fireEvent.change(input, { target: { value: 'anything' } });
    fireEvent.keyDown(input, { key: 'F', altKey: true, code: 'KeyF' });

    await waitFor(() => expect(store().scope).toBe('favorites'));
    expect(store().activeModal).toBeNull();
  });
});

describe('keyboard shortcuts', () => {
  it('Ctrl+A selects every visible bookmark and toggles back', async () => {
    seedLibrary([TOKIO, REACT]);
    await renderApp();

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await waitFor(() => expect(store().batchSelectedIds).toHaveLength(2));
    expect(await screen.findByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await waitFor(() => expect(store().batchSelectedIds).toHaveLength(0));
  });

  it('Ctrl+A only covers what the current scope shows', async () => {
    seedLibrary([TOKIO, makeResource({ title: 'Fav', isFavorite: true })]);
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: /^Favorites/ }));
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });

    await waitFor(() => expect(store().batchSelectedIds).toHaveLength(1));
    expect(store().resources.find((r) => r.id === store().batchSelectedIds[0])?.title).toBe('Fav');
  });

  it('Escape peels one layer at a time', async () => {
    seedLibrary([TOKIO, REACT]);
    await renderApp();

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await waitFor(() => expect(store().batchSelectedIds).toHaveLength(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Tokio runtime' }));
    await screen.findByRole('complementary', { name: 'Bookmark details' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(store().selectedResourceId).toBeNull());
    expect(store().batchSelectedIds).toHaveLength(2);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(store().batchSelectedIds).toHaveLength(0));
  });

  it('keeps a half-typed chat question when Escape is pressed in the detail panel', async () => {
    seedLibrary([TOKIO]);
    await renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Tokio runtime' }));
    const panel = await screen.findByRole('complementary', { name: 'Bookmark details' });

    const box = within(panel).getByLabelText('Ask about this bookmark…');
    box.focus();
    fireEvent.change(box, { target: { value: 'Is it fast?' } });
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(store().selectedResourceId).toBe(TOKIO.id);
    expect(box).toHaveValue('Is it fast?');
  });

  it('does not open the palette over another open dialog', async () => {
    await renderApp();
    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Add bookmark' }), 0));
    await screen.findByRole('dialog', { name: 'Add bookmark' });

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(store().activeModal).toBe('addLink');
    expect(screen.getByRole('dialog', { name: 'Add bookmark' })).toBeInTheDocument();
  });

  it('does not hijack Ctrl+A while the user is typing in a field', async () => {
    seedLibrary([TOKIO, REACT]);
    await renderApp();

    const search = screen.getByLabelText('Search bookmarks');
    fireEvent.keyDown(search, { key: 'a', ctrlKey: true });

    expect(store().batchSelectedIds).toHaveLength(0);
  });
});

describe('dialog focus handling', () => {
  it('focuses the first field and gives focus back to the trigger on close', async () => {
    await renderApp();
    const trigger = nth(screen.getAllByRole('button', { name: 'Add bookmark' }), 0);
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Add bookmark' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByLabelText('Address')).toHaveFocus();

    const submit = within(dialog).getByRole('button', { name: 'Add' });
    submit.focus();
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add bookmark' })).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe('notifications', () => {
  it('announces messages politely and errors as alerts from regions mounted before them', async () => {
    await renderApp();

    const region = await screen.findByRole('region', { name: 'Notifications' });
    const status = within(region).getByRole('status');
    const alert = within(region).getByRole('alert');
    expect(status).toBeEmptyDOMElement();
    expect(alert).toBeEmptyDOMElement();
    expect(
      status.parentElement?.closest('[aria-live], [role="status"], [role="alert"]'),
    ).toBeNull();

    store().pushToast('Something went fine', 'success');
    await waitFor(() => expect(status).toHaveTextContent('Something went fine'));
    expect(alert).toBeEmptyDOMElement();

    store().pushToast('Something broke', 'error');
    await waitFor(() => expect(alert).toHaveTextContent('Something broke'));
    expect(status).not.toHaveTextContent('Something broke');

    fireEvent.click(
      nth(within(region).getAllByRole('button', { name: 'Dismiss notification' }), 0),
    );
    await waitFor(() => expect(store().toasts).toHaveLength(1));
  });

  it('offers a skip link before the app chrome', async () => {
    await renderApp();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(document.getElementById('main-content')).not.toBeNull();
  });
});
