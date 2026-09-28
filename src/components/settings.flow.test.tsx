import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AISettings,
  DetectedProfile,
  ImportedBookmark,
  ModelInfo,
} from '../services/ipcTypes';
import {
  DEFAULT_AI_SETTINGS,
  deferred,
  ipcReject,
  mockRust,
  stopRust,
  type RustMock,
} from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { makeResource } from '../test/fixtures';
import { nth } from '../test/assert';

let rust: RustMock;
let settings: AISettings;

const openSettings = async (tab: 'AI provider' | 'Data' | 'Advanced') => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const tabs = await screen.findByRole('tablist', { name: 'Settings' });
  fireEvent.click(within(tabs).getByRole('tab', { name: tab }));
  return screen.findByRole('tabpanel');
};

beforeEach(() => {
  resetApp();
  settings = { ...DEFAULT_AI_SETTINGS };
  rust = mockRust({ get_ai_settings: () => settings });
});

afterEach(() => {
  stopRust();
});

describe('AI provider settings', () => {
  it('loads the current provider and discovers its models', async () => {
    rust.on('list_ollama_models', () => [
      { id: 'llama3', name: 'Llama 3' },
      { id: 'qwen2', name: 'Qwen 2' },
    ]);
    await renderApp();
    const panel = await openSettings('AI provider');

    expect(await within(panel).findByLabelText('Ollama address')).toHaveValue(
      'http://127.0.0.1:11434',
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh list' }));

    await waitForToast('2 models found.');
    const select = within(panel).getByLabelText('Model');
    expect(within(select).getByRole('option', { name: 'Qwen 2' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'qwen2' } });

    fireEvent.click(within(panel).getByRole('button', { name: 'Save settings' }));
    await waitForToast('AI settings saved.');
    expect(rust.argsOf('update_ai_settings')[0]?.payload).toMatchObject({
      provider: 'ollama',
      ollamaModel: 'qwen2',
    });
  });

  it('saves the embedding model picked for the agent bridge', async () => {
    rust.on('list_ollama_models', () => [
      { id: 'qwen2', name: 'Qwen 2' },
      { id: 'nomic-embed-text', name: 'nomic-embed-text', embedding: true },
    ]);
    await renderApp();
    const panel = await openSettings('AI provider');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    await waitForToast('2 models found.');

    const select = within(panel).getByLabelText('Embedding model');
    expect(within(select).getByRole('option', { name: 'Automatic' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Qwen 2' })).toBeNull();
    fireEvent.change(select, { target: { value: 'nomic-embed-text' } });
    fireEvent.change(within(panel).getByLabelText('Model'), { target: { value: 'qwen2' } });

    fireEvent.click(within(panel).getByRole('button', { name: 'Save settings' }));
    await waitForToast('AI settings saved.');
    expect(rust.argsOf('update_ai_settings')[0]?.payload).toMatchObject({
      ollamaModel: 'qwen2',
      embeddingModel: 'nomic-embed-text',
    });
  });

  it('shows the size and context length of each model, leaving out what is unknown', async () => {
    settings = { ...settings, ollamaModel: 'qwen2' };
    rust.on('list_ollama_models', () => [
      { id: 'qwen2', name: 'Qwen 2', sizeBytes: 4_683_087_332, contextLength: 32_768 },
      { id: 'tiny', name: 'Tiny', contextLength: 2048 },
      { id: 'bare', name: 'Bare' },
    ]);
    await renderApp();
    const panel = await openSettings('AI provider');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));

    const select = await within(panel).findByLabelText('Model');
    expect(
      await within(select).findByRole('option', { name: 'Qwen 2 · 4.7 GB · 32K context window' }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole('option', { name: 'Tiny · 2K context window' }),
    ).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Bare' })).toBeInTheDocument();
    expect(select).toHaveAccessibleDescription('4.7 GB · 32K context window');

    fireEvent.change(select, { target: { value: 'bare' } });
    expect(within(panel).queryByText('4.7 GB · 32K context window')).toBeNull();
  });

  it('explains an empty model list instead of leaving the select blank', async () => {
    rust.on('list_ollama_models', () => {
      throw { kind: 'network', code: 'ollamaUnreachable', message: 'connection refused' };
    });
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    expect(
      await within(panel).findByText(/could not reach Ollama at http:\/\/127\.0\.0\.1:11434/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/ollama\.com/)).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Switch to OpenRouter' }));
    expect(await within(panel).findByLabelText('OpenRouter API key')).toBeInTheDocument();
    expect(within(panel).getByText(/openrouter\.ai\/keys/)).toBeInTheDocument();
  });

  it('names the pull command when the server answers with no model installed', async () => {
    rust.on('list_ollama_models', () => []);
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    expect(await within(panel).findByText(/ollama pull llama3\.2/)).toBeInTheDocument();
  });

  it('reports a failed model lookup without losing the form', async () => {
    rust.on('list_ollama_models', () => {
      throw { kind: 'network', message: 'connection refused' };
    });
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    await waitForToast('Model list could not be loaded');
    expect(within(panel).getByLabelText('Ollama address')).toBeInTheDocument();
  });

  it('switches to OpenRouter and stores the key in the keychain', async () => {
    rust.on('set_openrouter_api_key', () => {
      settings = { ...settings, hasOpenrouterApiKey: true };
      return null;
    });
    rust.on('clear_openrouter_api_key', () => {
      settings = { ...settings, hasOpenrouterApiKey: false };
      return null;
    });
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('radio', { name: 'OpenRouter' }));
    expect(await within(panel).findByText('No API key stored')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Save key' }));
    expect(await within(panel).findByText('The API key cannot be empty.')).toBeInTheDocument();
    expect(rust.countOf('set_openrouter_api_key')).toBe(0);

    fireEvent.change(within(panel).getByLabelText('OpenRouter API key'), {
      target: { value: '  sk-or-v1-secret  ' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save key' }));

    await waitForToast('API key saved in the system credential store.');
    expect(nth(rust.argsOf('set_openrouter_api_key'), 0)).toEqual({ apiKey: 'sk-or-v1-secret' });
    expect(
      await within(panel).findByText('Key stored in the system credential store'),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText('OpenRouter API key')).toHaveValue('');

    fireEvent.click(within(panel).getByRole('button', { name: 'Remove key' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove the API key?' });
    expect(rust.countOf('clear_openrouter_api_key')).toBe(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove key' }));
    await waitForToast('API key removed.');
    expect(await within(panel).findByText('No API key stored')).toBeInTheDocument();
  });

  it('tests the connection with the settings currently in the form', async () => {
    rust.on('test_provider_connection', () => ({
      ok: true,
      message: 'Ollama answered',
      latencyMs: 42,
    }));
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.change(await within(panel).findByLabelText('Ollama address'), {
      target: { value: 'http://192.168.1.10:11434' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Test connection' }));

    await waitForToast('Ollama answered (42 ms)');
    expect(rust.argsOf('test_provider_connection')[0]?.payload).toMatchObject({
      ollamaBaseUrl: 'http://192.168.1.10:11434',
    });
    expect(rust.countOf('update_ai_settings')).toBe(0);
  });

  it('reports a failed connection test in the interface language', async () => {
    rust.on('test_provider_connection', () => ({
      ok: false,
      message: 'error sending request for url (http://127.0.0.1:11434/api/chat)',
      latencyMs: 5,
      reason: 'unreachable',
    }));
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Test connection' }));
    await waitForToast(
      'Could not connect: the server could not be reached. Check the address and that Ollama is running.',
    );
    expect(screen.queryByText(/error sending request/)).toBeNull();
  });

  it('says why a connection test failed instead of hiding the reason', async () => {
    settings = { ...DEFAULT_AI_SETTINGS, ollamaModel: 'olmayan-model:1b' };
    rust.on('test_provider_connection', () => ({
      ok: false,
      message: 'Model "olmayan-model:1b" is not installed on the Ollama server.',
      latencyMs: 2,
      reason: 'modelMissing',
    }));
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Test connection' }));
    await waitForToast('Could not connect: the model “olmayan-model:1b” is not installed.');
    expect(screen.queryByText(/is not installed on the Ollama server/)).toBeNull();
  });

  it('marks embedding models as unusable and refuses to save one', async () => {
    settings = { ...DEFAULT_AI_SETTINGS, ollamaModel: '' };
    const models: ModelInfo[] = [
      { id: 'bge-m3:latest', name: 'bge-m3:latest', embedding: true },
      { id: 'qwen3.5:9b', name: 'qwen3.5:9b' },
    ];
    rust.on('list_ollama_models', () => models);
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    await waitForToast('2 models found.');

    const select = within(panel).getByLabelText('Model');
    const embedding = within(select).getByRole('option', {
      name: 'bge-m3:latest (embedding model, cannot chat)',
    });
    expect(embedding).toBeDisabled();
    expect(select).toHaveValue('qwen3.5:9b');
  });

  it('marks a stored model the server does not have and leaves the choice to the user', async () => {
    settings = { ...DEFAULT_AI_SETTINGS, ollamaModel: 'qwen3.5:9b' };
    rust.on('list_ollama_models', () => [
      { id: 'fake-chat', name: 'fake-chat' },
      { id: 'nomic-embed-text', name: 'nomic-embed-text', embedding: true },
    ]);
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    await waitForToast('2 models found.');

    const select = within(panel).getByLabelText('Model');
    expect(
      within(select).getByRole('option', { name: 'qwen3.5:9b (not installed on this server)' }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'This model is not on the Ollama server. Pick an installed one or download it with Ollama.',
      ),
    ).toBeInTheDocument();
    // The missing model stays selected.
    expect(select).toHaveValue('qwen3.5:9b');

    fireEvent.change(select, { target: { value: 'fake-chat' } });
    expect(within(select).queryByRole('option', { name: /not installed/ })).toBeNull();
    expect(within(panel).queryByText(/does not have this model/)).toBeNull();
  });

  it('blocks saving an embedding model that was already stored', async () => {
    settings = { ...DEFAULT_AI_SETTINGS, ollamaModel: 'bge-m3:latest' };
    rust.on('list_ollama_models', () => [
      { id: 'bge-m3:latest', name: 'bge-m3:latest', embedding: true },
      { id: 'qwen3.5:9b', name: 'qwen3.5:9b' },
    ]);
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(await within(panel).findByRole('button', { name: 'Refresh list' }));
    await waitForToast('2 models found.');
    expect(
      await within(panel).findByText(
        'This is an embedding model and cannot chat. Pick a chat model.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Save settings' }));
    await waitForToast('This is an embedding model and cannot chat.');
    expect(rust.countOf('update_ai_settings')).toBe(0);
  });

  it('keeps the refresh button usable while a background model search runs', async () => {
    const first = deferred<ModelInfo[]>();
    rust.on('list_ollama_models', () =>
      rust.countOf('list_ollama_models') === 1
        ? first.promise
        : [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b' }],
    );
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.change(await within(panel).findByLabelText('Ollama address'), {
      target: { value: 'http://127.0.0.1:11500' },
    });
    const refresh = within(panel).getByRole('button', { name: 'Refresh list' });
    await waitFor(() => expect(refresh).toHaveAttribute('aria-busy', 'true'));

    expect(refresh).toBeEnabled();
    fireEvent.click(refresh);
    await waitForToast('1 model found.');
    first.resolve([]);
  });

  it('keeps an unsaved AI draft while another settings tab is open', async () => {
    await renderApp();
    const panel = await openSettings('AI provider');
    fireEvent.change(await within(panel).findByLabelText('Ollama address'), {
      target: { value: 'http://10.0.0.5:11434' },
    });

    const tabs = screen.getByRole('tablist', { name: 'Settings' });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Data' }));
    // Hidden panels stay mounted, so check the accessibility tree rather than the DOM.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Ollama address' })).toBeNull(),
    );
    fireEvent.click(within(tabs).getByRole('tab', { name: 'AI provider' }));

    const again = await screen.findByRole('tabpanel');
    expect(within(again).getByLabelText('Ollama address')).toHaveValue('http://10.0.0.5:11434');
  });

  it('refreshes the model list with the unsaved private-network toggle', async () => {
    rust.on('list_ollama_models', () => [{ id: 'llama3', name: 'Llama 3' }]);
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.click(
      await within(panel).findByRole('checkbox', { name: /Allow private network addresses/ }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh list' }));
    await waitForToast('1 model found.');

    const last = rust.argsOf('list_ollama_models').at(-1);
    expect(last).toMatchObject({ allowPrivateNetwork: true });
    expect(rust.countOf('update_ai_settings')).toBe(0);
  });

  it('keeps an unsaved draft when the interface language changes', async () => {
    await renderApp();
    const panel = await openSettings('AI provider');

    fireEvent.change(await within(panel).findByLabelText('Ollama address'), {
      target: { value: 'http://192.168.1.10:11434' },
    });
    const loads = rust.countOf('get_ai_settings');

    act(() => {
      store().setLang('tr');
    });

    expect(await within(panel).findByLabelText('Ollama adresi')).toHaveValue(
      'http://192.168.1.10:11434',
    );
    expect(rust.countOf('get_ai_settings')).toBe(loads);
  });

  it('shows a plain message when the settings cannot be read', async () => {
    rust.on('get_ai_settings', () => {
      throw { kind: 'keyring', message: 'locked' };
    });
    await renderApp();
    const panel = await openSettings('AI provider');

    expect(await within(panel).findByText('AI settings could not be loaded.')).toBeInTheDocument();
    await waitForToast('Settings could not be loaded');
  });
});

describe('importing from an installed browser', () => {
  it('detects profiles, imports the selected one and skips unreadable ones', async () => {
    const profiles: DetectedProfile[] = [
      { id: 'p1', browser: 'chrome', profileName: 'Default', bookmarkCount: 2 },
      { id: 'p2', browser: 'firefox', profileName: 'dev', bookmarkCount: 0, error: 'locked' },
    ];
    const bookmarks: ImportedBookmark[] = [
      { url: 'https://one.example.com/', title: 'One', folderPath: ['Bookmarks bar'] },
      { url: 'https://two.example.com/', title: 'Two', folderPath: ['Bookmarks bar', 'Dev'] },
    ];
    rust.on('detect_browsers', () => profiles);
    rust.on('read_browser_bookmarks', () => bookmarks);
    await renderApp();
    const panel = await openSettings('Data');

    fireEvent.click(within(panel).getByRole('button', { name: 'Find browsers' }));
    await waitForToast('2 browser profiles found.');

    const locked = await within(panel).findByRole('checkbox', { name: /Firefox · dev/ });
    expect(locked).toBeDisabled();
    // The reason comes from a code, never from raw Rust text.
    expect(
      within(panel).getByText(
        'The browser is open and has locked this profile. Close it and try again.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('checkbox', { name: /Chrome · Default/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Import selected (1)' }));

    await waitFor(() => expect(store().resources).toHaveLength(2));
    expect(nth(rust.argsOf('read_browser_bookmarks'), 0)).toEqual({ profileId: 'p1' });
    expect(
      store()
        .resources.map((r) => r.title)
        .sort(),
    ).toEqual(['One', 'Two']);
    await waitForToast('2 added, 0 already there, 0 skipped (invalid address).');
  });

  it('says a profile whose bookmarks are all here already brought nothing new', async () => {
    rust.on('detect_browsers', (): DetectedProfile[] => [
      { id: 'p1', browser: 'chrome', profileName: 'Default', bookmarkCount: 1 },
    ]);
    rust.on('read_browser_bookmarks', (): ImportedBookmark[] => [
      { url: 'https://one.example.com/', title: 'One', folderPath: [] },
    ]);
    seedLibrary([makeResource({ url: 'https://one.example.com/', title: 'One' })]);
    await renderApp();
    const panel = await openSettings('Data');

    fireEvent.click(within(panel).getByRole('button', { name: 'Find browsers' }));
    fireEvent.click(await within(panel).findByRole('checkbox', { name: /Chrome · Default/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Import selected (1)' }));

    await waitForToast('Every bookmark here is already in your library.');
    expect(store().resources).toHaveLength(1);
  });

  it('reports that no profile was found', async () => {
    await renderApp();
    const panel = await openSettings('Data');

    fireEvent.click(within(panel).getByRole('button', { name: 'Find browsers' }));
    expect(
      await within(panel).findByText('No browser profiles with bookmarks were found.'),
    ).toBeInTheDocument();
  });
});

describe('factory reset', () => {
  it('wipes the library and its images only after an explicit confirmation', async () => {
    seedLibrary([makeResource({ media: { snapshotFile: 'a.png' } })]);
    await renderApp();
    const panel = await openSettings('Advanced');

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete everything' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete everything?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(store().resources).toHaveLength(1);

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete everything' }));
    const again = await screen.findByRole('alertdialog', { name: 'Delete everything?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Delete everything' }));

    await waitFor(() => expect(store().resources).toHaveLength(0));
    expect(store().collections).toHaveLength(0);
    expect(store().chats).toEqual({});
    await waitFor(() => expect(rust.countOf('reset_snapshots')).toBe(1));
    await waitForToast('All data has been deleted.');
  });

  it('says nothing was deleted when the library file could not be read', async () => {
    rust.on('library_load', () => ipcReject('storage', 'library.json is locked'));
    await renderApp();
    const panel = await openSettings('Advanced');

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete everything' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete everything?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));

    await waitForToast('Your library file could not be read, so nothing was deleted.');
    expect(rust.countOf('reset_snapshots')).toBe(0);
    expect(store().toasts.map((toast) => toast.message)).not.toContain(
      'All data has been deleted.',
    );
  });

  it('shows the preview cache size and how many files the reset removed', async () => {
    rust.on('maintain_snapshots', () => ({
      deletedUnreferenced: 0,
      evicted: [],
      totalBytes: 123_400_000,
    }));
    rust.on('snapshot_dir_bytes', () => 123_400_000);
    rust.on('reset_snapshots', () => 12);
    seedLibrary([makeResource({ media: { snapshotFile: 'a.png' } })]);
    await renderApp();
    const panel = await openSettings('Advanced');

    expect(await within(panel).findByText('Preview images on disk: 123.4 MB')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete everything' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete everything?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));

    await waitForToast('All data has been deleted, including 12 preview files.');
    expect(within(panel).getByText('Preview images on disk: 0 bytes')).toBeInTheDocument();
  });

  it('reads the preview size again each time the tab is shown', async () => {
    rust.on('maintain_snapshots', () => ({ deletedUnreferenced: 0, evicted: [], totalBytes: 0 }));
    let onDisk = 0;
    rust.on('snapshot_dir_bytes', () => onDisk);
    seedLibrary([makeResource({ media: { snapshotFile: 'a.png' } })]);
    await renderApp();
    const panel = await openSettings('Advanced');
    expect(await within(panel).findByText('Preview images on disk: 0 bytes')).toBeInTheDocument();

    // A capture elsewhere wrote a file; the next visit to the tab shows it.
    onDisk = 2_500_000;
    await openSettings('Data');
    const again = await openSettings('Advanced');
    expect(await within(again).findByText('Preview images on disk: 2.5 MB')).toBeInTheDocument();
    expect(rust.countOf('snapshot_dir_bytes')).toBe(2);
  });
});
