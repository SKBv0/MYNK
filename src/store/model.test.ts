import { describe, expect, it } from 'vitest';
import {
  applyAnalysisToResource,
  createResource,
  dedupeResources,
  fixTimestamp,
  isPlausibleTimestamp,
  mergeChatLists,
  normalizeCollection,
  normalizeResource,
} from './model';
import { WEBKIT_EPOCH_OFFSET_MS } from '../lib/time';
import type { AnalyzeResult } from '../services/ipcTypes';
import type { ChatMessage, Resource } from '../types';

const NOW = Date.UTC(2026, 8, 1);
const YEAR_MS = 365 * 86_400_000;
const REAL_2022 = Date.UTC(2022, 5, 1);

const make = (url: string, patch: Partial<Resource> = {}): Resource => {
  const resource = createResource({ url }, NOW);
  if (!resource) throw new Error(`bad url ${url}`);
  return { ...resource, ...patch };
};

const analysis = (patch: Partial<AnalyzeResult> = {}): AnalyzeResult => ({
  title: 'T',
  description: '',
  categoryId: 'other',
  tags: [],
  summary: [],
  insufficientContent: false,
  confidence: 0.5,
  finalUrl: 'https://x.com',
  ...patch,
});

describe('timestamps', () => {
  it('isPlausibleTimestamp accepts 1990 … now + 1 year', () => {
    expect(isPlausibleTimestamp(REAL_2022, NOW)).toBe(true);
    expect(isPlausibleTimestamp(NOW + 30 * 86_400_000, NOW)).toBe(true);
    expect(isPlausibleTimestamp(NOW + 2 * YEAR_MS, NOW)).toBe(false);
    expect(isPlausibleTimestamp(Date.UTC(1985, 0, 1), NOW)).toBe(false);
    expect(isPlausibleTimestamp(1e20, NOW)).toBe(false);
    expect(isPlausibleTimestamp('2022', NOW)).toBe(false);
  });

  it('fixTimestamp shifts the old WebKit bug dates and replaces garbage with now', () => {
    expect(fixTimestamp(REAL_2022 + WEBKIT_EPOCH_OFFSET_MS, NOW)).toEqual({
      value: REAL_2022,
      fixed: true,
    });
    expect(fixTimestamp(1e20, NOW)).toEqual({ value: NOW, fixed: true });
    expect(fixTimestamp(5, NOW)).toEqual({ value: NOW, fixed: true });
    expect(fixTimestamp(undefined, NOW)).toEqual({ value: NOW, fixed: false });
  });

  it('normalizeResource repairs dates that would break the timeline', () => {
    const resource = normalizeResource(
      { url: 'https://ok.com', createdAt: 1e20, updatedAt: -3, lastOpenedAt: 1e20 },
      NOW,
    );
    expect(resource?.createdAt).toBe(NOW);
    expect(resource?.updatedAt).toBe(NOW);
    expect(resource?.lastOpenedAt).toBeNull();

    const fine = normalizeResource(
      { url: 'https://ok.com', createdAt: REAL_2022, updatedAt: REAL_2022 + 5, lastOpenedAt: NOW },
      NOW,
    );
    expect(fine).toMatchObject({
      createdAt: REAL_2022,
      updatedAt: REAL_2022 + 5,
      lastOpenedAt: NOW,
    });
  });

  it('createResource ignores implausible import dates and takes a valid updatedAt', () => {
    expect(createResource({ url: 'https://a.com', createdAt: 5 }, NOW)?.createdAt).toBe(NOW);
    expect(createResource({ url: 'https://a.com', createdAt: 1e20 }, NOW)?.createdAt).toBe(NOW);
    const imported = createResource(
      { url: 'https://a.com', createdAt: REAL_2022, updatedAt: REAL_2022 + 1000 },
      NOW,
    );
    expect(imported).toMatchObject({ createdAt: REAL_2022, updatedAt: REAL_2022 + 1000 });
    expect(
      createResource({ url: 'https://a.com', createdAt: REAL_2022, updatedAt: REAL_2022 - 1 }, NOW)
        ?.updatedAt,
    ).toBe(REAL_2022);
    expect(createResource({ url: 'https://a.com', createdAt: REAL_2022 }, NOW)?.updatedAt).toBe(
      NOW,
    );
  });
});

describe('intranet hosts', () => {
  it('createResource is strict by default and lenient for importers', () => {
    expect(createResource({ url: 'http://wiki/' }, NOW)).toBeNull();
    expect(createResource({ url: 'http://wiki/' }, NOW, { allowDotlessHost: true })?.url).toBe(
      'http://wiki/',
    );
  });

  it('normalizeResource keeps a stored intranet URL', () => {
    expect(normalizeResource({ url: 'http://jira/browse/X-1' }, NOW)?.url).toBe(
      'http://jira/browse/X-1',
    );
    expect(normalizeResource({ url: 'jira' }, NOW)).toBeNull();
  });
});

describe('applyAnalysisToResource', () => {
  it('keeps the current category when the result is `other`', () => {
    const resource = make('https://x.com', { categoryId: 'development' });
    expect(applyAnalysisToResource(resource, analysis(), NOW).categoryId).toBe('development');
    expect(
      applyAnalysisToResource(resource, analysis({ categoryId: 'research' }), NOW).categoryId,
    ).toBe('research');
  });

  it('keeps what the user changed while the analysis was running', () => {
    const edited = make('https://x.com', {
      description: 'Written by hand',
      categoryId: 'design',
      tags: ['mine'],
      updatedAt: NOW,
    });
    const result = analysis({
      description: 'From the model',
      categoryId: 'research',
      tags: ['ai'],
      summary: ['point'],
    });

    const next = applyAnalysisToResource(edited, result, NOW, NOW - 1000);

    expect(next.description).toBe('Written by hand');
    expect(next.categoryId).toBe('design');
    expect(next.summary).toEqual(['point']);
    expect(next.tags).toEqual(['mine', 'ai']);
    expect(next.ai.status).toBe('ok');
  });

  it('applies category and summary when the record was untouched since the analysis started', () => {
    const untouched = make('https://x.com', {
      description: 'old',
      summary: ['stale'],
      updatedAt: NOW,
      ai: { status: 'ok', analyzedAt: NOW - 5000, confidence: 0.5 },
    });
    const next = applyAnalysisToResource(
      untouched,
      analysis({ description: 'From the model', categoryId: 'research', summary: ['fresh'] }),
      NOW,
      NOW,
    );
    expect(next.description).toBe('old');
    expect(next.categoryId).toBe('research');
    expect(next.summary).toEqual(['fresh']);
  });

  it('keeps the description a never-analyzed record came with and only fills an empty one', () => {
    const noted = make('https://x.com', { description: 'from the agent', updatedAt: NOW });
    const result = analysis({ description: 'From the model', summary: ['point'] });

    const first = applyAnalysisToResource(noted, result, NOW, NOW);
    expect(first.description).toBe('from the agent');
    expect(first.summary).toEqual(['point']);

    const empty = make('https://y.com', { updatedAt: NOW });
    expect(applyAnalysisToResource(empty, result, NOW, NOW).description).toBe('From the model');
  });

  it('keeps a description the record came with on re-analysis while the summary refreshes', () => {
    const noted = make('https://x.com', { description: 'from the agent', updatedAt: NOW });
    const first = applyAnalysisToResource(
      noted,
      analysis({ description: 'From the model', summary: ['first'] }),
      NOW,
      NOW,
    );
    expect(first.descriptionByAi).toBeUndefined();
    const again = applyAnalysisToResource(
      first,
      analysis({ description: 'Fresher', summary: ['second'] }),
      NOW + 1,
      first.updatedAt,
    );
    expect(again.description).toBe('from the agent');
    expect(again.summary).toEqual(['second']);

    const bare = applyAnalysisToResource(
      make('https://y.com', { updatedAt: NOW }),
      analysis(),
      NOW,
      NOW,
    );
    expect(bare.description).toBe('');
    expect(bare.descriptionByAi).toBeUndefined();
    const filled = applyAnalysisToResource(
      bare,
      analysis({ description: 'Later text' }),
      NOW + 1,
      bare.updatedAt,
    );
    expect(filled.description).toBe('Later text');
    expect(filled.descriptionByAi).toBe(true);
  });

  it('rewrites the description the AI wrote itself, so a second analysis can correct the first', () => {
    const first = applyAnalysisToResource(
      make('https://reddit.com/', { updatedAt: NOW }),
      analysis({ description: 'A post about an election poll' }),
      NOW,
      NOW,
    );
    const again = applyAnalysisToResource(
      first,
      analysis({ description: 'A network of communities' }),
      NOW + 1,
      first.updatedAt,
    );
    expect(again.description).toBe('A network of communities');
    expect(again.descriptionByAi).toBe(true);

    // An empty answer keeps the previous text and its ownership.
    const silent = applyAnalysisToResource(again, analysis(), NOW + 2, again.updatedAt);
    expect(silent.description).toBe('A network of communities');
    expect(silent.descriptionByAi).toBe(true);
  });

  it('never replaces tags or key points the user edited', () => {
    const edited = make('https://x.com', {
      tags: ['mine'],
      tagsEditedByUser: true,
      summary: ['My point.'],
      summaryEditedByUser: true,
    });
    const after = applyAnalysisToResource(
      edited,
      analysis({ tags: ['model'], summary: ['Model point.'] }),
      NOW,
      edited.updatedAt,
    );
    expect(after.tags).toEqual(['mine']);
    expect(after.summary).toEqual(['My point.']);
  });

  it('keeps the edit flags through a save and load, and through a merge', () => {
    const edited = make('https://x.com', { tagsEditedByUser: true, summaryEditedByUser: true });
    const loaded = normalizeResource(JSON.parse(JSON.stringify(edited)), NOW);
    expect(loaded).toMatchObject({ tagsEditedByUser: true, summaryEditedByUser: true });

    const plain = make('https://www.x.com/', { createdAt: NOW - 1 });
    const [merged] = dedupeResources([plain, edited]).resources;
    expect(merged).toMatchObject({ tagsEditedByUser: true, summaryEditedByUser: true });
  });

  it('never replaces a title the user or an agent chose', () => {
    const chosen = make('https://x.com', { title: 'Agent added page', titleEditedByUser: true });
    expect(applyAnalysisToResource(chosen, analysis({ title: 'Model title' }), NOW).title).toBe(
      'Agent added page',
    );
  });
});

describe('dedupeResources with primaryIds', () => {
  const current = make('https://a.com/page', {
    createdAt: Date.UTC(2024, 0, 1),
    media: { snapshotFile: 'new-snap.png' },
  });
  const backup = make('https://www.a.com/page/', {
    createdAt: Date.UTC(2020, 0, 1),
    media: { snapshotFile: 'old-snap.png', imageUrl: 'https://cdn.a.com/og.png' },
    tags: ['from-backup'],
  });

  it('keeps the primary id and media file names when the other copy is older', () => {
    const { resources, remap } = dedupeResources([current, backup], {
      primaryIds: new Set([current.id]),
    });
    expect(resources).toHaveLength(1);
    expect(resources[0]?.id).toBe(current.id);
    expect(resources[0]?.createdAt).toBe(Date.UTC(2020, 0, 1));
    expect(resources[0]?.media).toEqual({
      snapshotFile: 'new-snap.png',
      imageUrl: 'https://cdn.a.com/og.png',
    });
    expect(resources[0]?.tags).toContain('from-backup');
    expect(remap.get(backup.id)).toBe(current.id);
  });

  it('without primaryIds the oldest record still survives', () => {
    const { resources, remap } = dedupeResources([current, backup]);
    expect(resources[0]?.id).toBe(backup.id);
    expect(remap.get(current.id)).toBe(backup.id);
  });
});

describe('normalizeCollection', () => {
  it('loads a stored collection and drops fields the model does not know', () => {
    const collection = normalizeCollection(
      { id: 'c1', name: 'Rust', keywords: ['rust'], pinnedIds: ['a', 'a'], color: '#f00' },
      NOW,
    );
    expect(collection).toEqual({
      id: 'c1',
      name: 'Rust',
      description: '',
      keywords: ['rust'],
      pinnedIds: ['a'],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
});

describe('mergeChatLists', () => {
  const msg = (id: string, createdAt: number, content = id): ChatMessage => ({
    id,
    role: 'user',
    content,
    createdAt,
  });

  it('unions by id (first wins) and sorts oldest first', () => {
    const merged = mergeChatLists(
      [msg('2', 20, 'mine'), msg('1', 10)],
      [msg('2', 20, 'theirs'), msg('3', 30)],
    );
    expect(merged.map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(merged[1]?.content).toBe('mine');
  });
});

describe('applyAnalysisToResource: weak titles from insufficient results', () => {
  const insufficient = (title: string): AnalyzeResult => ({
    title,
    description: '',
    categoryId: 'other',
    tags: [],
    summary: [],
    insufficientContent: true,
    confidence: 0.1,
    finalUrl: 'https://docs.example.com/handbook',
  });

  it('keeps an imported title when the page yielded only a fallback', () => {
    const imported = make('https://docs.example.com/handbook', { title: 'Intranet Handbook' });
    const next = applyAnalysisToResource(imported, insufficient('docs.example.com'), NOW);
    expect(next.title).toBe('Intranet Handbook');
    expect(next.ai.status).toBe('insufficient');
  });

  it('still fills in a URL-like title from an insufficient result', () => {
    const bare = make('https://example.com/a');
    expect(bare.title).toBe('example.com');
    const next = applyAnalysisToResource(bare, insufficient('Example A'), NOW);
    expect(next.title).toBe('Example A');
  });
});
