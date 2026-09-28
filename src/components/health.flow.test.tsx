import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { emit } from '@tauri-apps/api/event';
import type { LinkHealthResult } from '../services/ipcTypes';
import { HEALTH_SCAN_PROGRESS_EVENT } from '../services/linkHealth';
import { deferred, mockRust, stopRust, type RustMock } from '../test/ipc';
import { renderApp, resetApp, seedLibrary, store, waitForToast } from '../test/app';
import { NOW, makeResource } from '../test/fixtures';
import { nth } from '../test/assert';

let rust: RustMock;

const GOOD = 'https://alive.example.com/';
const BROKEN = 'https://gone.example.com/';
const FLAKY = 'https://flaky.example.com/';

const check = (url: string, patch: Partial<LinkHealthResult>): LinkHealthResult => ({
  url,
  ok: false,
  definitelyBroken: false,
  previewBlocked: false,
  errorKind: 'none',
  ...patch,
});

const openHealthPage = async () => {
  // The sidebar entry also shows the broken-link count, so match loosely.
  fireEvent.click(screen.getByRole('button', { name: /^Link health/ }));
  return screen.findByRole('heading', { name: 'Link health', level: 1 });
};

const healthOf = (url: string) => store().resources.find((r) => r.url === url)?.health;

/** `check_links_health` under the test's control: it resolves when the test says so. */
const gatedScan = () => {
  const gate = deferred<LinkHealthResult[]>();
  const seen = { runId: '', urls: [] as string[] };
  rust.on('check_links_health', (args) => {
    seen.runId = args.runId as string;
    seen.urls = args.urls as string[];
    return gate.promise;
  });
  return { gate, seen };
};

beforeEach(() => {
  resetApp();
  rust = mockRust();
});

afterEach(() => {
  stopRust();
});

describe('link health scan', () => {
  it('reports progress, then applies each result kind correctly', async () => {
    seedLibrary([
      makeResource({ url: GOOD, title: 'Alive' }),
      makeResource({ url: BROKEN, title: 'Gone' }),
      makeResource({
        url: FLAKY,
        title: 'Flaky',
        health: { status: 'alive', checkedAt: NOW - 1000 },
      }),
    ]);
    const { gate, seen } = gatedScan();
    await renderApp();
    await openHealthPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check links' }));

    await waitFor(() => expect(seen.urls).toHaveLength(3));
    const hud = await screen.findByRole('region', { name: 'Background tasks' });

    await act(async () => {
      await emit(HEALTH_SCAN_PROGRESS_EVENT, { runId: seen.runId, processed: 2, total: 3 });
    });
    await waitFor(() =>
      expect(within(hud).getByRole('progressbar', { name: 'Link check' })).toHaveAttribute(
        'aria-valuenow',
        '2',
      ),
    );

    await act(async () => {
      gate.resolve([
        check(GOOD, { ok: true, status: 200 }),
        check(BROKEN, { definitelyBroken: true, status: 404, errorKind: 'http' }),
        check(FLAKY, { errorKind: 'timeout' }),
      ]);
      await gate.promise;
    });

    await waitFor(() => expect(store().healthMeta.hasRun).toBe(true));
    expect(healthOf(GOOD)).toMatchObject({ status: 'alive', httpStatus: 200 });
    expect(healthOf(BROKEN)).toMatchObject({ status: 'dead', httpStatus: 404 });
    expect(healthOf(FLAKY)).toMatchObject({ status: 'alive', checkedAt: NOW - 1000 });
    await waitForToast('Check finished: 1 broken, 0 protected, 1 uncertain.');
  });

  it('says why each broken link failed', async () => {
    const NO_HOST = 'https://no-such-host.example.com/';
    seedLibrary([
      makeResource({ url: BROKEN, title: 'Gone' }),
      makeResource({ url: NO_HOST, title: 'Nowhere' }),
    ]);
    rust.on('check_links_health', () => [
      check(BROKEN, { definitelyBroken: true, status: 404, errorKind: 'http' }),
      check(NO_HOST, { definitelyBroken: true, errorKind: 'dns' }),
    ]);
    await renderApp();
    await openHealthPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check links' }));

    const rowOf = async (reason: string) =>
      (await screen.findByText(reason)).closest('li') as HTMLElement;
    expect(within(await rowOf('404 Not found')).getByText('Gone')).toBeInTheDocument();
    expect(within(await rowOf('Address not found')).getByText('Nowhere')).toBeInTheDocument();
    expect(healthOf(NO_HOST)).toMatchObject({ status: 'dead', errorKind: 'dns' });
  });

  it('remembers where a working link now lands, but not a login wall', async () => {
    const WALLED = 'https://walled.example.com/';
    seedLibrary([makeResource({ url: GOOD }), makeResource({ url: WALLED })]);
    rust.on('check_links_health', () => [
      check(GOOD, { ok: true, status: 200, finalUrl: 'https://alive.example.com/en/' }),
      check(WALLED, { ok: true, status: 403, finalUrl: 'https://walled.example.com/login' }),
    ]);
    await renderApp();
    await openHealthPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check links' }));

    await waitFor(() =>
      expect(store().finalUrls).toEqual({ 'alive.example.com': 'https://alive.example.com/en/' }),
    );
  });

  it('marks a site that answers 403 as protected, not broken', async () => {
    seedLibrary([makeResource({ url: GOOD, title: 'Members only' })]);
    const { gate } = gatedScan();
    await renderApp();
    await openHealthPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check links' }));

    await act(async () => {
      gate.resolve([check(GOOD, { ok: true, status: 403, previewBlocked: true })]);
      await gate.promise;
    });

    await waitFor(() => expect(healthOf(GOOD)?.status).toBe('protected'));
    expect(store().resources[0]?.media.previewBlocked).toBe(true);
  });

  it('cancelling asks Rust to stop the running chunk and keeps the partial results', async () => {
    seedLibrary([
      makeResource({ url: GOOD, title: 'Alive' }),
      makeResource({ url: BROKEN, title: 'Gone' }),
    ]);
    const { gate, seen } = gatedScan();
    await renderApp();
    await openHealthPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check links' }));

    await waitFor(() => expect(seen.runId).not.toBe(''));
    fireEvent.click(screen.getByRole('button', { name: 'Stop check' }));

    await waitFor(() => expect(rust.countOf('cancel_health_scan')).toBe(1));
    expect(nth(rust.argsOf('cancel_health_scan'), 0)).toEqual({ runId: seen.runId });

    await act(async () => {
      gate.resolve([check(GOOD, { ok: true, status: 200 })]);
      await gate.promise;
    });

    await waitFor(() => expect(healthOf(GOOD)?.status).toBe('alive'));
    expect(healthOf(BROKEN)?.status).toBe('unknown');
    await waitForToast('Check cancelled');
  });

  it('counts progress across chunks and ignores late events of a finished chunk', async () => {
    // 120 links: three calls (50 + 50 + 20) in flight together, each with its own run id.
    seedLibrary(
      Array.from({ length: 120 }, (_, i) =>
        makeResource({ url: `https://link-${i}.example.com/`, title: `Link ${i}` }),
      ),
    );
    const gates = new Map<string, ReturnType<typeof deferred<LinkHealthResult[]>>>();
    const sizes: number[] = [];
    rust.on('check_links_health', (args) => {
      sizes.push((args.urls as string[]).length);
      const gate = deferred<LinkHealthResult[]>();
      gates.set(args.runId as string, gate);
      return gate.promise;
    });

    await renderApp();
    await openHealthPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check links' }));

    await waitFor(() => expect(gates.size).toBe(3));
    expect(sizes).toEqual([50, 50, 20]);
    const [firstRun, secondRun, thirdRun] = [...gates.keys()];

    await act(async () => {
      await emit(HEALTH_SCAN_PROGRESS_EVENT, { runId: firstRun, processed: 30, total: 50 });
      await emit(HEALTH_SCAN_PROGRESS_EVENT, { runId: secondRun, processed: 10, total: 50 });
    });
    await waitFor(() => expect(store().jobs.health?.done).toBe(40));

    await act(async () => {
      gates.get(firstRun ?? '')?.resolve([]);
      await gates.get(firstRun ?? '')?.promise;
    });

    await act(async () => {
      await emit(HEALTH_SCAN_PROGRESS_EVENT, { runId: firstRun, processed: 50, total: 50 });
      await emit(HEALTH_SCAN_PROGRESS_EVENT, { runId: thirdRun, processed: 5, total: 20 });
    });
    // 50 settled + 10 + 5 running; the late event of the settled chunk adds nothing.
    await waitFor(() => expect(store().jobs.health?.done).toBe(65));

    await act(async () => {
      for (const run of [secondRun, thirdRun]) {
        gates.get(run ?? '')?.resolve([]);
        await gates.get(run ?? '')?.promise;
      }
    });
    await waitFor(() => expect(store().jobs.health?.state).toBe('done'));
    expect(store().jobs.health?.done).toBe(120);
    expect(store().jobs.health?.total).toBe(120);
  });

  it('deletes the broken links and their images only after a confirmation', async () => {
    seedLibrary([
      makeResource({
        url: BROKEN,
        title: 'Gone',
        health: { status: 'dead', checkedAt: NOW },
        media: { snapshotFile: 'dead-1.png' },
      }),
      makeResource({ url: GOOD, title: 'Alive', health: { status: 'alive', checkedAt: NOW } }),
    ]);
    store().setHealthMeta({ hasRun: true, lastScanAt: NOW });
    await renderApp();
    await openHealthPage();

    fireEvent.click(screen.getByRole('button', { name: 'Delete broken bookmarks' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete broken bookmarks?' });
    expect(
      within(dialog).getByText(
        '1 bookmark with a broken link will be deleted. This cannot be undone.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(store().resources).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Delete broken bookmarks' }));
    const again = await screen.findByRole('alertdialog', { name: 'Delete broken bookmarks?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(store().resources).toHaveLength(1));
    expect(store().resources[0]?.url).toBe(GOOD);
    await waitFor(() => expect(rust.countOf('delete_snapshots')).toBe(1));
    expect(nth(rust.argsOf('delete_snapshots'), 0)).toEqual({ fileNames: ['dead-1.png'] });
    await waitForToast('1 broken bookmark deleted.');
  });

  it('offers the import instead of five zeroes when the library is empty', async () => {
    await renderApp();
    await openHealthPage();

    expect(await screen.findByRole('heading', { name: 'Your library is empty' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Check links/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import bookmarks' }));
    expect(store().page).toBe('settings');
    const tabs = await screen.findByRole('tablist', { name: 'Settings' });
    expect(within(tabs).getByRole('tab', { name: 'Data' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('hides the count on the bulk buttons while there is nothing to do', async () => {
    seedLibrary([
      makeResource({
        url: GOOD,
        media: { snapshotFile: 'a.png' },
        ai: { status: 'ok', analyzedAt: NOW, confidence: 0.9 },
      }),
    ]);
    await renderApp();
    await openHealthPage();

    expect(await screen.findByRole('button', { name: 'Take missing previews' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeDisabled();
  });

  it('asks before an AI run long enough to matter, and names the OpenRouter cost', async () => {
    rust.on('get_ai_settings', () => ({
      provider: 'openrouter',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: '',
      openrouterModel: 'openai/gpt-4o-mini',
      hasOpenrouterApiKey: true,
      allowPrivateNetwork: false,
    }));
    seedLibrary(
      Array.from({ length: 201 }, (_, i) => makeResource({ url: `https://n${i}.example.com/` })),
    );
    await renderApp();
    await openHealthPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze 201 bookmarks' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Start the analysis?' });
    expect(within(dialog).getByText(/OpenRouter charges for every bookmark/)).toBeVisible();
    expect(rust.countOf('analyze_url')).toBe(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rust.countOf('analyze_url')).toBe(0);
  });

  it('lets a preview issue row wrap its actions instead of squashing the title', async () => {
    seedLibrary([makeResource({ url: GOOD, title: 'No picture yet' })]);
    await renderApp();
    await openHealthPage();

    const title = await screen.findByText('No picture yet');
    const row = title.closest('li');
    // jsdom has no layout: the classes are what keep the text readable beside a docked inspector.
    expect(row?.className).toContain('flex-wrap');
    expect(title.parentElement?.className).toContain('basis-48');
    const actions = within(row as HTMLElement).getByRole('button', {
      name: 'Take again',
    }).parentElement;
    expect(actions?.className).toContain('shrink-0');
    expect(
      within(actions as HTMLElement).getByRole('button', { name: 'Upload' }),
    ).toBeInTheDocument();
  });
});
