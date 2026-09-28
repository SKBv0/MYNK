import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MarkdownRenderer from './MarkdownRenderer';
import { openExternalUrl } from '../services/aiService';

vi.mock('../services/aiService', () => ({
  openExternalUrl: vi.fn(() => Promise.resolve()),
}));

describe('MarkdownRenderer links', () => {
  it('opens every kind of click in the system browser instead of the app window', () => {
    render(<MarkdownRenderer text="See [the docs](https://example.com/docs)." />);
    const link = screen.getByRole('link', { name: 'the docs' });

    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.click(link)).toBe(false);
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(false);
    expect(fireEvent.click(link, { metaKey: true })).toBe(false);

    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);

    expect(vi.mocked(openExternalUrl)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(openExternalUrl)).toHaveBeenCalledWith('https://example.com/docs');
  });
});

describe('MarkdownRenderer inline emphasis', () => {
  it('keeps underscores inside identifiers and still italicises a standalone _phrase_', () => {
    const { container } = render(<MarkdownRenderer text="Use user_id_field, _not_ this." />);
    expect(container.textContent).toContain('user_id_field');
    const em = container.querySelectorAll('em');
    expect(em).toHaveLength(1);
    expect(em[0]?.textContent).toBe('not');
  });

  it('keeps balanced parentheses in a link target', () => {
    render(<MarkdownRenderer text="[Film](https://en.wikipedia.org/wiki/Heat_(1995_film)) here" />);
    fireEvent.click(screen.getByRole('link', { name: 'Film' }));
    expect(vi.mocked(openExternalUrl)).toHaveBeenLastCalledWith(
      'https://en.wikipedia.org/wiki/Heat_(1995_film)',
    );
  });
});
