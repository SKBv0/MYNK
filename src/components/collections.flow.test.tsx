import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { makeCollection, makeResource } from '../test/fixtures';

let rust: RustMock;

const RUST = makeResource({
  url: 'https://tokio.rs/',
  title: 'Tokio',
  tags: ['rust', 'async'],
});
const DESIGN = makeResource({
  url: 'https://refactoringui.com/',
  title: 'Refactoring UI',
  tags: ['design'],
});

const openCollections = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Collections/ }));
  return screen.findByRole('heading', { name: 'Collections', level: 1 });
};

const typeKeyword = (dialog: HTMLElement, keyword: string) => {
  const input = within(dialog).getByLabelText('Keywords');
  fireEvent.change(input, { target: { value: keyword } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('collections', () => {
  it('creates a smart folder and previews what it will contain', async () => {
    seedLibrary([RUST, DESIGN]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Async Rust' } });
    typeKeyword(dialog, 'rust');

    expect(await within(dialog).findByText('1 match')).toBeInTheDocument();
    expect(within(dialog).getByText('Tokio')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }));

    await waitFor(() => expect(store().collections).toHaveLength(1));
    expect(store().collections[0]).toMatchObject({ name: 'Async Rust', keywords: ['rust'] });
    await waitForToast('Collection created.');
    expect(await screen.findByText('1 bookmark')).toBeInTheDocument();
  });

  it('asks before throwing away an unsaved form and closes a clean one directly', async () => {
    seedLibrary([RUST]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    let dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.keyDown(within(dialog).getByLabelText('Name'), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New collection' })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    dialog = await screen.findByRole('dialog', { name: 'New collection' });
    const name = within(dialog).getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Half typed' } });
    fireEvent.keyDown(name, { key: 'Escape' });

    const confirm = await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Half typed');

    fireEvent.keyDown(within(dialog).getByLabelText('Name'), { key: 'Escape' });
    const again = await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
    fireEvent.click(within(again).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New collection' })).toBeNull(),
    );
    expect(store().collections).toHaveLength(0);
  });

  it('refuses to save without a name or a keyword', async () => {
    seedLibrary([RUST]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }));

    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Add at least one keyword.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Keywords')).toHaveAttribute('aria-invalid', 'true');
    expect(store().collections).toHaveLength(0);
  });

  it('asks the AI for keywords and adds the ones that are new', async () => {
    rust.on('chat_complete', () => '```json\n{"keywords":["rust","tokio","async"]}\n```');
    seedLibrary([RUST]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Async Rust' } });
    typeKeyword(dialog, 'rust');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suggest with AI' }));

    await waitForToast('2 keywords suggested.');
    expect(
      within(dialog).getByRole('button', { name: 'Remove keyword tokio' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Remove keyword async' }),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: /^Remove keyword/ })).toHaveLength(3);
  });

  it('asks for a name before suggesting keywords', async () => {
    seedLibrary([RUST]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suggest with AI' }));

    expect(await within(dialog).findByText('Enter a name first.')).toBeInTheDocument();
    expect(rust.countOf('chat_complete')).toBe(0);
  });

  it('edits an existing collection', async () => {
    seedLibrary([RUST], [makeCollection({ name: 'Async', keywords: ['rust'] })]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Edit collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit collection' });
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Async');
    fireEvent.change(name, { target: { value: 'Async Rust' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitForToast('Collection updated.');
    expect(store().collections[0]?.name).toBe('Async Rust');
    expect(store().collections[0]?.keywords).toEqual(['rust']);
  });

  it('deletes a collection only after confirmation and keeps its bookmarks', async () => {
    seedLibrary([RUST], [makeCollection({ name: 'Async', keywords: ['rust'] })]);
    await renderApp();
    await openCollections();

    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this collection?' });
    expect(within(dialog).getByText(/Its bookmarks stay in your library/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(store().collections).toHaveLength(0));
    expect(store().resources).toHaveLength(1);
    await waitForToast('Collection deleted.');
  });

  it('pins a bookmark to a collection from the inspector', async () => {
    const collection = makeCollection({ name: 'Design', keywords: ['design'] });
    seedLibrary([RUST], [collection]);
    await renderApp();

    fireEvent.click(await screen.findByRole('button', { name: 'Show details for Tokio' }));
    const panel = await screen.findByRole('complementary', { name: 'Bookmark details' });

    const chip = within(panel).getByRole('button', { name: 'Design' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);

    await waitFor(() => expect(store().collections[0]?.pinnedIds).toEqual([RUST.id]));
    expect(within(panel).getByRole('button', { name: 'Design' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(within(panel).getByRole('button', { name: 'Design' }));
    await waitFor(() => expect(store().collections[0]?.pinnedIds).toEqual([]));
  });

  it('shows the collection chip only on the library pages it filters', async () => {
    seedLibrary([RUST, DESIGN], [makeCollection({ name: 'Alps', keywords: ['rust'] })]);
    store().openCollection(store().collections[0]?.id ?? '');
    await renderApp();

    expect(await screen.findByText('Showing: Alps')).toBeInTheDocument();
    act(() => store().goToPage('health'));
    await waitFor(() => expect(screen.queryByText('Showing: Alps')).toBeNull());
    act(() => store().goToPage('settings'));
    await waitFor(() => expect(screen.queryByText('Showing: Alps')).toBeNull());
    // Back in the library the scope still applies, so the chip returns.
    act(() => store().goToPage('library'));
    expect(await screen.findByText('Showing: Alps')).toBeInTheDocument();
  });
});
