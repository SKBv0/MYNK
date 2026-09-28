import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { createResource } from '../model';
import { useAppStore } from '../index';
import {
  cancelEnrichment,
  enrichCounts,
  orderEnrichTargets,
  pauseEnrichment,
  resetEnrichmentForTests,
  resumeEnrichment,
  startEnrichment,
} from './enrich';
import { resetMediaCacheForTests } from './media';
import { deferred, mockRust, stopRust, type RustMock } from '../../test/ipc';
import type { AnalyzeResult } from '../../services/ipcTypes';
import type { Resource } from '../../types';

afterEach(() => {
  resetMediaCacheForTests();
  stopRust();
  useAppStore.setState({ resources: [] });
});

describe('enrichment cancellation', () => {
  it('cancels in-flight analyses in Rust and resets their status', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const rejecters = new Map<string, (reason: unknown) => void>();
    const cancelled: string[] = [];
    mockIPC((cmd, args) => {
      const payload = args as Record<string, unknown>;
      if (cmd === 'analyze_url') {
        const requestId = payload.requestId as string;
        expect(typeof requestId).toBe('string');
        return new Promise((resolve, reject) => {
          pending.set(requestId, resolve);
          rejecters.set(requestId, reject);
        });
      }
      if (cmd === 'cancel_request') {
        const requestId = payload.requestId as string;
        cancelled.push(requestId);
        rejecters.get(requestId)?.({ kind: 'cancelled', message: 'The request was cancelled.' });
        return null;
      }
      return null;
    });

    const resources = ['https://a.com', 'https://b.com', 'https://c.com'].map((url) => {
      const r = createResource({ url });
      if (!r) throw new Error('fixture');
      return r;
    });
    useAppStore.setState({ resources });

    const run = startEnrichment(resources.map((r) => r.id));
    // Concurrency 2: two requests are in flight, the third is queued.
    await vi.waitFor(() => expect(pending.size).toBe(2));
    expect(useAppStore.getState().jobs.enrich?.state).toBe('running');

    cancelEnrichment();
    await run;

    expect(cancelled.sort()).toEqual([...pending.keys()].sort());
    const statuses = useAppStore.getState().resources.map((r) => r.ai.status);
    expect(statuses).toEqual(['none', 'none', 'none']);
    expect(useAppStore.getState().jobs.enrich?.state).toBe('cancelled');
  });
});

describe('enrichment restarts', () => {
  const PRISTINE = useAppStore.getState();
  let rust: RustMock;

  const analysis: AnalyzeResult = {
    title: 'Analysed',
    description: 'desc',
    categoryId: 'development',
    tags: ['tag'],
    summary: ['point'],
    insufficientContent: false,
    confidence: 0.8,
    finalUrl: 'https://a.com/',
  };

  const seedOne = () => {
    const r = createResource({ url: 'https://a.com' });
    if (!r) throw new Error('fixture');
    useAppStore.setState({ resources: [r] });
    return r.id;
  };
  const state = () => useAppStore.getState();

  beforeEach(() => {
    useAppStore.setState(PRISTINE, true);
    rust = mockRust();
  });

  afterEach(() => {
    resetEnrichmentForTests();
    stopRust();
  });

  it('does not let a cancelled run overwrite the run started right after it', async () => {
    const first = deferred<AnalyzeResult>();
    const second = deferred<AnalyzeResult>();
    rust.on('analyze_url', () =>
      rust.countOf('analyze_url') === 1 ? first.promise : second.promise,
    );
    rust.on('cancel_request', () => {
      first.reject({ kind: 'cancelled', message: 'The request was cancelled.' });
      return null;
    });
    const id = seedOne();

    const run1 = startEnrichment([id]);
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(1));
    cancelEnrichment();
    const run2 = startEnrichment([id]);
    await run1;

    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(2));
    expect(state().resources[0]?.ai.status).toBe('pending');
    expect(state().busy.enrich).toEqual([id]);
    expect(state().jobs.enrich?.state).toBe('running');

    second.resolve(analysis);
    await run2;
    expect(state().resources[0]?.ai.status).toBe('ok');
    expect(state().busy.enrich).toEqual([]);
    expect(state().jobs.enrich).toMatchObject({ state: 'done', total: 1, done: 1 });
  });

  it('does not overwrite fields the user edited while the analysis was running', async () => {
    const gate = deferred<AnalyzeResult>();
    rust.on('analyze_url', () => gate.promise);
    const id = seedOne();
    // An older stamp, so the edit below is guaranteed to change `updatedAt`.
    useAppStore.setState((s) => ({
      resources: s.resources.map((r) => ({ ...r, updatedAt: Date.now() - 60_000 })),
    }));

    const run = startEnrichment([id]);
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(1));
    state().updateResource(id, { description: 'Mine', categoryId: 'design' }, { byUser: true });
    gate.resolve(analysis);
    await run;

    const resource = state().resources[0];
    expect(resource?.description).toBe('Mine');
    expect(resource?.categoryId).toBe('design');
    // Fields the user left empty are still filled, and tags always merge.
    expect(resource?.summary).toEqual(['point']);
    expect(resource?.tags).toContain('tag');
    expect(resource?.ai.status).toBe('ok');
  });

  it('can wait for one record instead of for the whole run', async () => {
    const slow = deferred<AnalyzeResult>();
    rust.on('analyze_url', (args) => (args.url === 'https://slow.com/' ? slow.promise : analysis));
    const make = (url: string) => {
      const r = createResource({ url });
      if (!r) throw new Error('fixture');
      return r;
    };
    const [hanging, added] = [make('https://slow.com'), make('https://added.com')];
    useAppStore.setState({ resources: [hanging, added] });

    const bulk = startEnrichment([hanging.id]);
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(1));
    const outcome = await Promise.race([
      startEnrichment([added.id], { awaitTargets: true }).then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50)),
    ]);

    expect(outcome).toBe('settled');
    expect(state().resources[1]?.ai.status).toBe('ok');
    expect(state().jobs.enrich?.state).toBe('running');

    slow.resolve(analysis);
    await bulk;
  });

  it('does not hold a waiting caller behind a paused run', async () => {
    const slow = deferred<AnalyzeResult>();
    rust.on('analyze_url', (args) => (args.url === 'https://slow.com/' ? slow.promise : analysis));
    const hanging = createResource({ url: 'https://slow.com' });
    const queued = createResource({ url: 'https://queued.com' });
    const added = createResource({ url: 'https://added.com', ai: { status: 'pending' } });
    if (!hanging || !queued || !added) throw new Error('fixture');
    useAppStore.setState({ resources: [hanging, queued, added] });

    const bulk = startEnrichment([hanging.id, queued.id]);
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(2));
    pauseEnrichment();
    const outcome = await Promise.race([
      startEnrichment([added.id], { awaitTargets: true }).then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50)),
    ]);

    expect(outcome).toBe('settled');
    // Not shown as analyzing while nothing runs it; the user is told why.
    expect(state().resources[2]?.ai.status).toBe('none');
    expect(state().toasts.map((toast) => toast.message)).toContain(
      'Analysis is paused. This bookmark goes first when you resume.',
    );

    resumeEnrichment();
    slow.resolve(analysis);
    await bulk;
    expect(state().resources[2]?.ai.status).toBe('ok');
  });

  it('starting twice at once analyzes each record only once', async () => {
    const gate = deferred<AnalyzeResult>();
    rust.on('analyze_url', () => gate.promise);
    const id = seedOne();

    const a = startEnrichment([id]);
    const b = startEnrichment([id]);
    await vi.waitFor(() => expect(rust.countOf('analyze_url')).toBe(1));
    gate.resolve(analysis);
    await Promise.all([a, b]);

    expect(rust.countOf('analyze_url')).toBe(1);
    expect(state().jobs.enrich).toMatchObject({ state: 'done', total: 1 });
  });
});

describe('cancelling an enrichment run keeps analyzed records analyzed', () => {
  const PRISTINE = useAppStore.getState();
  let rust: RustMock;
  const state = () => useAppStore.getState();

  const make = (url: string, ai: Partial<Resource['ai']>) => {
    const r = createResource({ url, ai });
    if (!r) throw new Error('fixture');
    return r;
  };

  /** Every analysis hangs until the test (or `cancel_request`) settles it. */
  const hangingAnalyses = () => {
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    const byRequest = new Map<string, string>();
    rust.on('analyze_url', (args) => {
      const url = args.url as string;
      byRequest.set(args.requestId as string, url);
      const gate = deferred<AnalyzeResult>();
      gates.set(url, gate);
      return gate.promise;
    });
    rust.on('cancel_request', (args) => {
      gates
        .get(byRequest.get(args.requestId as string) ?? '')
        ?.reject({ kind: 'cancelled', message: 'The request was cancelled.' });
      return null;
    });
    return gates;
  };

  beforeEach(() => {
    useAppStore.setState(PRISTINE, true);
    rust = mockRust();
  });

  afterEach(() => {
    resetEnrichmentForTests();
    stopRust();
  });

  it('gives every record its previous status back after pause, resume and cancel', async () => {
    const gates = hangingAnalyses();
    const resources = [
      make('https://a.com', { status: 'ok', analyzedAt: 111, confidence: 0.9 }),
      make('https://b.com', { status: 'ok' }),
      make('https://c.com', { status: 'insufficient' }),
      make('https://d.com', { status: 'none' }),
      make('https://e.com', { status: 'failed', error: 'earlier failure' }),
    ];
    useAppStore.setState({ resources });

    const run = startEnrichment(resources.map((r) => r.id));
    // Concurrency 2: the first two are in flight, the rest are still queued.
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(state().resources[0]?.ai.status).toBe('pending');
    pauseEnrichment();
    resumeEnrichment();
    cancelEnrichment();
    await run;

    expect(state().resources.map((r) => r.ai.status)).toEqual([
      'ok',
      'ok',
      'insufficient',
      'none',
      'failed',
    ]);
    expect(state().resources[0]?.ai).toMatchObject({ analyzedAt: 111, confidence: 0.9 });
    expect(state().resources[4]?.ai.error).toBe('earlier failure');
    expect(state().jobs.enrich?.state).toBe('cancelled');
  });

  it('restores the status of a single cancelled analysis as well', async () => {
    const gates = hangingAnalyses();
    const resource = make('https://a.com', { status: 'insufficient' });
    useAppStore.setState({ resources: [resource] });

    const run = startEnrichment([resource.id]);
    await vi.waitFor(() => expect(gates.size).toBe(1));
    cancelEnrichment();
    await run;

    expect(state().resources[0]?.ai.status).toBe('insufficient');
  });

  it('offers the AI settings for a single analysis instead of marking the record failed', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'network', code: 'ollamaUnreachable', message: 'connection refused' };
    });
    const resource = make('https://a.com', { status: 'ok', analyzedAt: 111 });
    useAppStore.setState({ resources: [resource] });

    await startEnrichment([resource.id]);

    expect(state().resources[0]?.ai).toMatchObject({ status: 'ok', analyzedAt: 111 });
    // The user stays on the page they were on; the toast's action leads to the settings notice.
    expect(state().page).toBe('library');
    expect(state().toasts.map((t) => t.type)).toEqual(['info']);
    state().toasts[0]?.action?.run();
    expect(state().page).toBe('settings');
    expect(state().settingsTabRequest).toBe('ai');
    expect(state().aiSetupNotice).toEqual({
      reason: 'ollamaUnreachable',
      targets: [resource.id],
    });
  });

  it('keeps the page title a setup failure came back with, unless the user named the bookmark', async () => {
    rust.on('analyze_url', (args) => ({
      title: 'The Rust Programming Language',
      description: '',
      categoryId: 'other',
      tags: [],
      summary: [],
      insufficientContent: true,
      confidence: 0.1,
      finalUrl: args.url as string,
      setupError: { kind: 'config', code: 'modelMissing', model: 'qwen3:8b', message: 'no' },
    }));
    const byHost = make('https://www.rust-lang.org/learn', { status: 'none' });
    const named = make('https://rust-lang.org/tools', { status: 'none' });
    useAppStore.setState({
      resources: [byHost, { ...named, title: 'Rust tools', titleEditedByUser: true }],
    });

    await startEnrichment([byHost.id, named.id]);

    expect(state().resources.map((r) => r.title)).toEqual([
      'The Rust Programming Language',
      'Rust tools',
    ]);
    // Still a setup failure: nothing is marked failed and the settings are offered.
    expect(state().resources.map((r) => r.ai.status)).toEqual(['none', 'none']);
    expect(state().aiSetupNotice).toBeNull();
    expect(state().toasts.map((t) => t.type)).toEqual(['info']);
  });

  it('a background run offers the AI settings once instead of taking over the page', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'network', code: 'ollamaUnreachable', message: 'connection refused' };
    });
    const first = make('https://a.com', { status: 'none' });
    const second = make('https://b.com', { status: 'none' });
    useAppStore.setState({ resources: [first, second] });

    await startEnrichment([first.id], { background: true });
    expect(state().page).toBe('library');
    expect(state().aiSetupNotice).toBeNull();
    expect(state().toasts.map((t) => t.type)).toEqual(['info']);
    expect(state().toasts[0]?.action).toBeTruthy();

    for (const toast of state().toasts) state().dismissToast(toast.id);
    await startEnrichment([second.id], { background: true });
    expect(state().toasts).toEqual([]);
  });

  it('marks a record as failed when its own analysis fails', async () => {
    rust.on('analyze_url', () => {
      throw { kind: 'parse', message: 'unreadable' };
    });
    const resource = make('https://a.com', { status: 'ok' });
    useAppStore.setState({ resources: [resource] });

    await startEnrichment([resource.id]);

    expect(state().resources[0]?.ai.status).toBe('failed');
    expect(state().resources[0]?.ai.error).toBeTruthy();
  });
});

describe('enrichment counters and order', () => {
  const PRISTINE = useAppStore.getState();
  let rust: RustMock;

  const make = (url: string, status: 'none' | 'failed') => {
    const r = createResource({ url, ai: { status } });
    if (!r) throw new Error('fixture');
    return r;
  };
  const result = (url: string): AnalyzeResult => ({
    title: url,
    description: '',
    categoryId: 'other',
    tags: [],
    summary: [],
    insufficientContent: false,
    confidence: 0.5,
    finalUrl: url,
  });

  beforeEach(() => {
    useAppStore.setState(PRISTINE, true);
    rust = mockRust();
  });

  afterEach(() => {
    resetEnrichmentForTests();
    stopRust();
  });

  it('records the address the analysis ended on only when the page was read', async () => {
    const walled = make('https://walled.com', 'none');
    const read = make('https://read.com', 'none');
    rust.on('analyze_url', (args) => {
      const url = args.url as string;
      const base = { ...result(url), finalUrl: 'https://login.example.com/' };
      return url.includes('walled') ? { ...base, insufficientContent: true } : base;
    });
    useAppStore.setState({ resources: [walled, read] });

    await startEnrichment([walled.id, read.id]);

    const { finalUrls } = useAppStore.getState();
    expect(finalUrls['walled.com']).toBeUndefined();
    expect(finalUrls['read.com']).toBe('https://login.example.com/');
  });

  it('counts processed records without the analyses the user cancelled', () => {
    expect(
      enrichCounts({
        state: 'cancelled',
        total: 54,
        done: 4,
        failed: 4,
        running: 0,
        errorsByKind: { parse: 2, cancelled: 2 },
      }),
    ).toEqual({ total: 54, done: 6, failed: 2 });
  });

  it('puts never-analyzed records first and failed ones last, keeping the order', () => {
    const list = [
      make('https://f1.com', 'failed'),
      make('https://n1.com', 'none'),
      make('https://f2.com', 'failed'),
      make('https://n2.com', 'none'),
    ];
    expect(orderEnrichTargets(list).map((r) => r.url)).toEqual([
      'https://n1.com/',
      'https://n2.com/',
      'https://f1.com/',
      'https://f2.com/',
    ]);
  });

  it('sends failed records after the records that were never analyzed', async () => {
    rust.on('analyze_url', (args) => result(args.url as string));
    useAppStore.setState({
      resources: [
        make('https://f1.com', 'failed'),
        make('https://n1.com', 'none'),
        make('https://n2.com', 'none'),
      ],
    });

    await startEnrichment();

    expect(rust.argsOf('analyze_url').map((a) => a.url)).toEqual([
      'https://n1.com/',
      'https://n2.com/',
      'https://f1.com/',
    ]);
  });

  it('shows the same numbers in the cancel toast as in the progress card', async () => {
    const urls = ['https://a.com/', 'https://b.com/', 'https://c.com/', 'https://d.com/'];
    const gates = new Map<string, ReturnType<typeof deferred<AnalyzeResult>>>();
    const byRequest = new Map<string, string>();
    rust.on('analyze_url', (args) => {
      const url = args.url as string;
      if (url === urls[0]) return result(url);
      if (url === urls[1]) throw { kind: 'parse', message: 'unreadable' };
      byRequest.set(args.requestId as string, url);
      const gate = deferred<AnalyzeResult>();
      gates.set(url, gate);
      return gate.promise;
    });
    rust.on('cancel_request', (args) => {
      gates
        .get(byRequest.get(args.requestId as string) ?? '')
        ?.reject({ kind: 'cancelled', message: 'The request was cancelled.' });
      return null;
    });
    useAppStore.setState({ resources: urls.map((url) => make(url, 'none')) });

    const run = startEnrichment();
    await vi.waitFor(() => expect(gates.size).toBe(2));
    cancelEnrichment();
    await run;

    const job = useAppStore.getState().jobs.enrich;
    expect(job).toMatchObject({ state: 'cancelled', total: 4, done: 2, failed: 1 });
    await vi.waitFor(() =>
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContain(
        'Analysis cancelled: 2 of 4 processed.',
      ),
    );
  });
});
