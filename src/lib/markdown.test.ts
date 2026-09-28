import { describe, expect, it } from 'vitest';
import { parseBlocks } from './markdown';

describe('parseBlocks', () => {
  it('parses only real markdown (no heuristic headings)', () => {
    const blocks = parseBlocks(
      [
        '# Title',
        'Short line',
        'continues here',
        '',
        '- one',
        '* two',
        '1. first',
        '```',
        'code',
        '```',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'Short line continues here' },
      { type: 'list', ordered: false, items: ['one', 'two'] },
      { type: 'list', ordered: true, items: ['first'] },
      { type: 'code', text: 'code' },
    ]);
  });

  it('does not turn "Label: value" lines into anything special', () => {
    expect(parseBlocks('Note: this is a paragraph')).toEqual([
      { type: 'paragraph', text: 'Note: this is a paragraph' },
    ]);
  });
});
