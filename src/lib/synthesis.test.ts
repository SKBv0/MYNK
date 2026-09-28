import { describe, expect, it } from 'vitest';
import type { SynthesisItem } from '../services/aiService';
import { buildSynthesisRequest, withSourceList } from './synthesis';

const items: SynthesisItem[] = [
  {
    title: 'Rust async',
    description: 'Tokio guide',
    categoryId: 'development',
    tags: ['rust', 'async'],
    summary: ['Futures are lazy.', 'Use spawn.'],
    url: 'https://tokio.rs',
  },
  {
    title: 'Design tokens',
    description: 'Naming',
    categoryId: 'design',
    tags: [],
    summary: [],
    url: 'https://example.com/tokens',
  },
];

describe('buildSynthesisRequest', () => {
  it('numbers every item and grounds the report in the given items only', () => {
    const req = buildSynthesisRequest(items, 'tr');
    expect(req.lang).toBe('tr');
    expect(req.history).toEqual([]);
    expect(req.prompt).toContain('Synthesize these 2 bookmarks');
    expect(req.prompt).toContain('[#1] Rust async');
    expect(req.prompt).toContain('url: https://example.com/tokens');
    expect(req.prompt).toContain('key points: Futures are lazy. Use spawn.');
    expect(req.system).toMatch(/never invent sources/);
  });

  it('asks for numbered citations and plain structure', () => {
    const { system } = buildSynthesisRequest(items, 'en');
    expect(system).toContain('cite the bookmark it comes from with its number, e.g. [#2]');
    expect(system).toContain('A title on the first line, as "# Title".');
    expect(system).toContain('Do not summarize the bookmarks one by one');
    expect(system).toContain('A final "## Conclusion"');
  });

  it('names the closing section in the report language', () => {
    const { system } = buildSynthesisRequest(items, 'tr');
    expect(system).toContain('A final "## Sonuç"');
    expect(system).not.toContain('Conclusion');
    expect(system).toContain('every heading in the same language as the report');
  });
});

describe('withSourceList', () => {
  const sources = [
    { id: 'a', title: 'Rust async', url: 'https://tokio.rs' },
    { id: 'b', title: 'Design tokens', url: 'https://example.com/tokens' },
  ];

  it('appends a numbered list that matches the [#n] citations', () => {
    expect(withSourceList('# Report\n\nText [#2].\n', sources, 'Sources')).toBe(
      [
        '# Report',
        '',
        'Text [#2].',
        '',
        '## Sources',
        '',
        '1. Rust async <https://tokio.rs>',
        '2. Design tokens <https://example.com/tokens>',
      ].join('\n'),
    );
  });

  it('leaves the text alone when there are no sources', () => {
    expect(withSourceList('Text', [], 'Sources')).toBe('Text');
  });
});
