import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { libraryLoad, mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store } from '../test/app';
import { NOW, makeResource } from '../test/fixtures';
import { GLOBAL_CHAT_KEY } from '../types';
import { flushPersistence } from '../store/persistence';
import { nth } from '../test/assert';

let rust: RustMock;

const setLanguage = (code: 'EN' | 'TR') =>
  fireEvent.click(screen.getByRole('radio', { name: code }));

const openGlobalChat = async () => {
  fireEvent.click(screen.getByRole('button', { name: /More actions|Diğer eylemler/ }));
  const item = await screen.findByRole('menuitem', {
    name: /Ask your library|Kütüphanene sor/,
  });
  fireEvent.click(item);
  return screen.findByRole('dialog');
};

const withUsage = () => {
  store().appendChatMessage(GLOBAL_CHAT_KEY, {
    id: 'a1',
    role: 'assistant',
    content: 'Answer',
    createdAt: NOW,
    usage: { promptTokens: 1200, completionTokens: 34, provider: 'ollama', model: 'llama3' },
  });
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('language', () => {
  it('swaps every visible string and the document language', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');

    setLanguage('TR');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ayarlar' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.getByLabelText('Yer imlerinde ara')).toHaveAttribute(
      'placeholder',
      'Yer imlerinde ara…',
    );
    expect(document.documentElement.lang).toBe('tr');
    expect(store().lang).toBe('tr');
  });

  it('formats dates and numbers with the matching locale', async () => {
    seedLibrary([makeResource({ title: 'Dated', createdAt: NOW })]);
    await renderApp();
    withUsage();

    expect(await screen.findByText('Mar 15, 2026')).toBeInTheDocument();
    const chat = await openGlobalChat();
    expect(within(chat).getByText(/1,234 tokens/)).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    setLanguage('TR');

    expect(await screen.findByText('15 Mar 2026')).toBeInTheDocument();
    const trChat = await openGlobalChat();
    expect(within(trChat).getByText(/1\.234/)).toBeInTheDocument();
  });

  it('chooses the plural form from the count', async () => {
    seedLibrary([makeResource({ title: 'One' })]);
    await renderApp();

    const hud = await screen.findByRole('region', { name: 'Background tasks' });
    expect(within(hud).getByText('1 bookmark has no summary yet.')).toBeInTheDocument();

    store().addResource({ url: 'https://second.example.com/' });
    await waitFor(() =>
      expect(within(hud).getByText('2 bookmarks have no summary yet.')).toBeInTheDocument(),
    );

    // Turkish nouns do not inflect after a numeral: one form for every count.
    setLanguage('TR');
    await waitFor(() =>
      expect(within(hud).getByText('2 yer iminin henüz özeti yok.')).toBeInTheDocument(),
    );
    store().removeResources([nth(store().resources, 0).id]);
    await waitFor(() =>
      expect(within(hud).getByText('1 yer iminin henüz özeti yok.')).toBeInTheDocument(),
    );
  });
});

describe('appearance', () => {
  it('applies the theme choice and writes it to the library file', async () => {
    await renderApp();
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(store().themeMode).toBe('light');

    await flushPersistence();
    const saved = rust.argsOf('library_save').at(-1)?.json as string;
    expect(JSON.parse(saved).settings).toMatchObject({ themeMode: 'light', lang: 'en' });
  });

  it('applies a new accent color and keeps it', async () => {
    await renderApp();
    const picker = screen.getByRole('radiogroup', { name: 'Accent color' });

    const violet = within(picker).getByRole('radio', { name: /^Violet/ });
    fireEvent.click(violet);

    await waitFor(() => expect(store().theme.accent).toBe('#8b5cf6'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#8b5cf6');

    await flushPersistence();
    const saved = rust.argsOf('library_save').at(-1)?.json as string;
    expect(JSON.parse(saved).settings.theme.accent).toBe('#8b5cf6');
  });

  it('checks no swatch for an accent outside the list but keeps one tab stop', async () => {
    await renderApp();
    store().setTheme({ ...store().theme, accent: 'rgb(1, 2, 3)' });
    const picker = screen.getByRole('radiogroup', { name: 'Accent color' });

    const radios = await within(picker).findAllByRole('radio');
    await waitFor(() =>
      expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toEqual([]),
    );
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  });

  it('remembers the language and theme across a restart', async () => {
    const { unmount } = await renderApp();
    setLanguage('TR');
    fireEvent.click(screen.getByRole('radio', { name: 'Açık' }));
    await waitFor(() => expect(store().themeMode).toBe('light'));
    await flushPersistence();
    const saved = rust.argsOf('library_save').at(-1)?.json as string;

    unmount();
    resetApp();
    rust = mockRust({ library_load: () => libraryLoad(saved) });
    await renderApp();

    expect(await screen.findByRole('button', { name: 'Ayarlar' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
