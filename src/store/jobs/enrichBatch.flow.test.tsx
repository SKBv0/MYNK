import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AnalyzeResult } from '../../services/ipcTypes';
import { DEFAULT_AI_SETTINGS, deferred, mockRust, stopRust, type RustMock } from '../../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../../test/app';
import { makeResource } from '../../test/fixtures';
import { startEnrichment } from './enrich';

let rust: RustMock;

const URLS = [
  'https://one.example.com/',
  'https://two.example.com/',
  'https://three.example.com/',
] as const;

const result = (url: string): AnalyzeResult => ({
  title: `Analysed ${url}`,
  description: 'desc',
  categoryId: 'development',
  tags: ['tag'],
  summary: ['point'],
  insufficientContent: false,
  confidence: 0.8,
  finalUrl: url,
});

const seedThree = () =>
  seedLibrary(URLS.map((url, i) => makeResource({ url, title: `Item ${i + 1}` })));

/** Selects every visible bookmark the way the user does: Ctrl+A on the library. */
const selectAll = async () => {
  fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
  await waitFor(() => expect(store().batchSelectedIds).toHaveLength(3));
  return screen.findByRole('toolbar', { name: 'Selection actions' });
};

const startBatch = async () => {
  const dock = await selectAll();
  fireEvent.click(within(dock).getByRole('button', { name: 'Analyze' }));
  return screen.findByRole('region', { name: 'Background tasks' });
};

const statuses = () => store().resources.map((r) => r.ai.status);

/** A missing AI setup is offered in a toast; its action opens the settings notice. */
const openAiSettingsFromToast = async () => {
  await waitForToast('Choose an AI model to analyze your bookmarks.');
  expect(store().page).toBe('library');
  const toast = store().toasts.find((t) => t.message.includes('Choose an AI model'));
  act(() => toast?.action?.run());
  return screen.findByRole('tabpanel');
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('bulk AI analysis', () => {
  it('analyzes every selected bookmark and reports the outcome', async () => {
    rust.on('analyze_url', (args) => result(args.url as string));
    seedThree();
    await renderApp();
    const hud = await startBatch();

    expect(within(hud).getByText('Analysis')).toBeInTheDocument();
    await waitFor(() => expect(statuses()).toEqual(['ok', 'ok', 'ok']));
    await waitForToast('Analysis finished: 3 processed, 0 with errors.');
    expect(store().jobs.enrich).toMatchObject({ state: 'done', total: 3, done: 3, failed: 0 });
    expect(rust.countOf('analyze_url')).toBe(3);
  });

  it('shows real progress on a labeled progress bar', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    rust.on('analyze_url', (args) => {
      const url = args.url as string;
      const gate = deferred<AnalyzeResult>();
      gates.set(url, gate);
      return gate.promise;
    });
    seedThree();
    await renderApp();
    const hud = await startBatch();

    const bar = within(hud).getByRole('progressbar', { name: 'Analysis' });
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(bar).toHaveAttribute('aria-valuenow', '0');

    await waitFor(() => expect(gates.size).toBe(2));
    gates.get(URLS[0])?.resolve(result(URLS[0]));
    await waitFor(() =>
      expect(within(hud).getByRole('progressbar', { name: 'Analysis' })).toHaveAttribute(
        'aria-valuenow',
        '1',
      ),
    );
    expect(within(hud).getByText(/1 of 3/)).toBeInTheDocument();

    gates.get(URLS[1])?.resolve(result(URLS[1]));
    await waitFor(() => expect(gates.size).toBe(3));
    gates.get(URLS[2])?.resolve(result(URLS[2]));
    await waitFor(() => expect(store().jobs.enrich?.state).toBe('done'));
  });

  it('highlights the card being analyzed and follows it until the user scrolls', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    rust.on('analyze_url', (args) => {
      const gate = deferred<AnalyzeResult>();
      gates.set(args.url as string, gate);
      return gate.promise;
    });
    seedThree();
    await renderApp();
    const scrollEl = document.getElementById('main-content');
    if (!scrollEl) throw new Error('scroll container missing');
    // A viewport shorter than a card, so the analyzed row is never fully in view.
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 100 });
    const scrollTo = vi.fn();
    scrollEl.scrollTo = scrollTo;

    await startBatch();
    await waitFor(() => expect(gates.size).toBe(2));
    expect(document.querySelectorAll('[data-analyzing]')).toHaveLength(2);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });

    // The user takes over the scroll position: the third analysis must not move the view.
    fireEvent.wheel(scrollEl);
    scrollTo.mockClear();
    gates.get(URLS[0])?.resolve(result(URLS[0]));
    await waitFor(() => expect(gates.size).toBe(3));
    expect(document.querySelectorAll('[data-analyzing]')).toHaveLength(2);
    expect(scrollTo).not.toHaveBeenCalled();

    for (const url of [URLS[1], URLS[2]]) gates.get(url)?.resolve(result(url));
    await waitFor(() => expect(statuses()).toEqual(['ok', 'ok', 'ok']));
    expect(document.querySelector('[data-analyzing]')).toBeNull();
  });

  it('does not move the view for a run the user did not start', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    rust.on('analyze_url', (args) => {
      const gate = deferred<AnalyzeResult>();
      gates.set(args.url as string, gate);
      return gate.promise;
    });
    seedThree();
    await renderApp();
    const scrollEl = document.getElementById('main-content');
    if (!scrollEl) throw new Error('scroll container missing');
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 100 });
    const scrollTo = vi.fn();
    scrollEl.scrollTo = scrollTo;

    const run = startEnrichment([store().resources[0]?.id ?? ''], { background: true });
    await waitFor(() => expect(document.querySelectorAll('[data-analyzing]')).toHaveLength(1));
    expect(scrollTo).not.toHaveBeenCalled();

    gates.get(URLS[0])?.resolve(result(URLS[0]));
    await run;
  });

  it('pauses without starting new work and resumes where it stopped', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    rust.on('analyze_url', (args) => {
      const gate = deferred<AnalyzeResult>();
      gates.set(args.url as string, gate);
      return gate.promise;
    });
    seedThree();
    await renderApp();
    const hud = await startBatch();

    // Concurrency is 2: two requests are in flight, the third is still queued.
    await waitFor(() => expect(rust.countOf('analyze_url')).toBe(2));
    fireEvent.click(within(hud).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(store().jobs.enrich?.state).toBe('paused'));

    for (const url of [URLS[0], URLS[1]]) gates.get(url)?.resolve(result(url));
    await waitFor(() => expect(statuses().filter((s) => s === 'ok')).toHaveLength(2));
    // Still paused: the queued third analysis has not been sent.
    expect(rust.countOf('analyze_url')).toBe(2);
    expect(store().jobs.enrich?.state).toBe('paused');

    fireEvent.click(within(hud).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(rust.countOf('analyze_url')).toBe(3));
    gates.get(URLS[2])?.resolve(result(URLS[2]));
    await waitFor(() => expect(statuses()).toEqual(['ok', 'ok', 'ok']));
  });

  it('cancelling drops the queue and cancels the requests already in flight', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    const byRequestId = new Map<string, string>();
    const cancelled: string[] = [];
    rust.on('analyze_url', (args) => {
      const url = args.url as string;
      byRequestId.set(args.requestId as string, url);
      const gate = deferred<AnalyzeResult>();
      gates.set(url, gate);
      return gate.promise;
    });
    rust.on('cancel_request', (args) => {
      const id = args.requestId as string;
      cancelled.push(id);
      gates
        .get(byRequestId.get(id) ?? '')
        ?.reject({ kind: 'cancelled', message: 'The request was cancelled.' });
      return null;
    });
    seedThree();
    await renderApp();
    const hud = await startBatch();

    await waitFor(() => expect(rust.countOf('analyze_url')).toBe(2));
    fireEvent.click(within(hud).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(cancelled).toHaveLength(2));
    await waitFor(() => expect(store().jobs.enrich?.state).toBe('cancelled'));
    // Nothing is left marked "pending": a cancelled run leaves its records unanalyzed.
    await waitFor(() => expect(statuses()).toEqual(['none', 'none', 'none']));
    await waitForToast('Analysis cancelled: 0 of 3 processed.');
    expect(rust.countOf('analyze_url')).toBe(2);
  });

  it('keeps going when one bookmark fails and counts it in the result', async () => {
    rust.on('analyze_url', (args) => {
      if (args.url === URLS[1]) throw { kind: 'parse', message: 'unreadable page' };
      return result(args.url as string);
    });
    seedThree();
    await renderApp();
    await startBatch();

    await waitFor(() => expect(store().jobs.enrich?.state).toBe('done'));
    expect(statuses()).toEqual(['ok', 'failed', 'ok']);
    expect(store().resources[1]?.ai.error).toContain('could not be understood');
    await waitForToast('Analysis finished: 2 processed, 1 with errors.');
  });

  it('sends the user to the AI settings instead of failing every bookmark', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'network', code: 'ollamaUnreachable', message: 'connection refused' };
    });
    seedThree();
    await renderApp();
    await startBatch();

    await waitFor(() => expect(store().jobs.enrich?.state).toBe('cancelled'));
    // Setup errors show no error toast and leave records unmarked.
    expect(statuses()).toEqual(['none', 'none', 'none']);
    expect(store().toasts.filter((t) => t.type === 'error')).toHaveLength(0);
    expect(rust.countOf('analyze_url')).toBeLessThanOrEqual(2);

    const panel = await openAiSettingsFromToast();
    expect(store().aiSetupNotice).toEqual({
      reason: 'ollamaUnreachable',
      targets: store().resources.map((r) => r.id),
    });
    expect(await within(panel).findByText('AI is not ready yet')).toBeInTheDocument();
    expect(
      within(panel).getByText(/could not reach Ollama at http:\/\/127\.0\.0\.1:11434/),
    ).toBeInTheDocument();
  });

  it('names the missing model and restarts the analysis from the notice', async () => {
    let broken = true;
    rust.on('analyze_url', (args) => {
      if (broken) throw { kind: 'config', code: 'modelMissing', model: 'qwen3:8b', message: 'no' };
      return result(args.url as string);
    });
    seedThree();
    await renderApp();
    await startBatch();

    const panel = await openAiSettingsFromToast();
    expect(
      await within(panel).findByText(/The model “qwen3:8b” is not installed/),
    ).toBeInTheDocument();

    broken = false;
    fireEvent.click(within(panel).getByRole('button', { name: 'Continue analysis' }));
    await waitFor(() => expect(store().page).toBe('library'));
    expect(store().aiSetupNotice).toBeNull();
    await waitFor(() => expect(statuses()).toEqual(['ok', 'ok', 'ok']));
  });

  it('continues only the run that stopped, not the whole library', async () => {
    let broken = true;
    rust.on('analyze_url', (args) => {
      if (broken) throw { kind: 'config', code: 'modelMissing', model: 'qwen3:8b', message: 'no' };
      return result(args.url as string);
    });
    seedThree();
    await renderApp();
    const first = store().resources[0]?.id ?? '';
    act(() => {
      void startEnrichment([first]);
    });

    const panel = await openAiSettingsFromToast();
    await within(panel).findByText(/The model “qwen3:8b” is not installed/);
    expect(store().aiSetupNotice?.targets).toEqual([first]);
    await waitFor(() => expect(store().jobs.enrich?.state).toBe('cancelled'));

    broken = false;
    fireEvent.click(within(panel).getByRole('button', { name: 'Continue analysis' }));
    await waitFor(() => expect(statuses()).toEqual(['ok', 'none', 'none']));
    await waitFor(() => expect(store().jobs.enrich?.state).toBe('done'));
    expect(rust.argsOf('analyze_url').map((args) => args.url)).toEqual([URLS[0], URLS[0]]);
  });

  it('does not continue with an embedding model, which would stop the run again', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'config', code: 'notChatModel', model: 'nomic-embed-text', message: 'no' };
    });
    rust.on('get_ai_settings', () => ({ ...DEFAULT_AI_SETTINGS, ollamaModel: 'nomic-embed-text' }));
    rust.on('list_ollama_models', () => [
      { id: 'nomic-embed-text', name: 'nomic-embed-text', embedding: true },
      { id: 'llama3.2', name: 'Llama 3.2' },
    ]);
    seedThree();
    await renderApp();
    await startBatch();

    const panel = await openAiSettingsFromToast();
    const select = await within(panel).findByLabelText('Model');
    await within(select).findByRole('option', { name: 'Llama 3.2' });
    const calls = rust.countOf('analyze_url');
    fireEvent.click(within(panel).getByRole('button', { name: 'Continue analysis' }));

    await waitForToast('This is an embedding model and cannot chat. Pick a chat model.');
    expect(store().page).toBe('settings');
    expect(rust.countOf('analyze_url')).toBe(calls);
  });

  it('saves the edited model before continuing, instead of looping the user back', async () => {
    let installed = false;
    rust.on('analyze_url', (args) => {
      if (!installed)
        throw { kind: 'config', code: 'modelMissing', model: 'qwen3:8b', message: '' };
      return result(args.url as string);
    });
    rust.on('list_ollama_models', () => [{ id: 'llama3.2', name: 'Llama 3.2' }]);
    rust.on('update_ai_settings', (args) => {
      installed = true;
      return { ...DEFAULT_AI_SETTINGS, ...(args.payload as object) };
    });
    seedThree();
    await renderApp();
    await startBatch();

    const panel = await openAiSettingsFromToast();
    await within(panel).findByText(/The model “qwen3:8b” is not installed/);
    expect(within(panel).getByRole('button', { name: 'Continue analysis' })).toBeInTheDocument();

    const select = await within(panel).findByLabelText('Model');
    await within(select).findByRole('option', { name: 'Llama 3.2' });
    fireEvent.change(select, { target: { value: 'llama3.2' } });
    fireEvent.click(
      await within(panel).findByRole('button', { name: 'Save and continue analysis' }),
    );

    await waitFor(() => expect(rust.countOf('update_ai_settings')).toBe(1));
    expect(rust.argsOf('update_ai_settings')[0]?.payload).toMatchObject({
      ollamaModel: 'llama3.2',
    });
    await waitFor(() => expect(store().page).toBe('library'));
    await waitFor(() => expect(statuses()).toEqual(['ok', 'ok', 'ok']));
  });

  it('offers the way to the AI settings instead of navigating under an open dialog', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    rust.on('analyze_url', (args) => {
      const gate = deferred<AnalyzeResult>();
      gates.set(args.url as string, gate);
      return gate.promise;
    });
    seedThree();
    await renderApp();
    await startBatch();
    await waitFor(() => expect(gates.size).toBe(2));

    act(() => store().openModal('addLink'));
    await screen.findByRole('dialog');
    for (const gate of gates.values()) gate.reject({ kind: 'keyring', message: 'locked' });

    await waitForToast('Choose an AI model to analyze your bookmarks.');
    // The dialog holds what the user typed, so the page must not change under it.
    expect(store().page).toBe('library');
    const toast = store().toasts.find((t) => t.message.includes('Choose an AI model'));
    expect(toast?.action?.label).toBe('Open AI settings');

    act(() => toast?.action?.run());
    expect(store().page).toBe('settings');
    expect(store().aiSetupNotice).toMatchObject({ reason: 'keyring' });
  });

  it('still stops the whole run once when the desktop runtime is missing', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'desktopOnly', message: 'browser' };
    });
    seedThree();
    await renderApp();
    await startBatch();

    await waitFor(() => expect(store().jobs.enrich?.state).toBe('cancelled'));
    await waitForToast('Analysis stopped');
    // The fatal error is reported exactly once, not per bookmark.
    expect(store().toasts.filter((t) => t.message.includes('Analysis stopped'))).toHaveLength(1);
    expect(rust.countOf('analyze_url')).toBeLessThanOrEqual(2);
  });
});
