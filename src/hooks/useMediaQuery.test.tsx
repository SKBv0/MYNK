import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useMediaQuery, WIDE_LAYOUT_QUERY } from './useMediaQuery';

const original = window.matchMedia;

const stubMatchMedia = () => {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const matchMedia = vi.fn(
    (media: string) =>
      ({
        matches: false,
        media,
        addEventListener,
        removeEventListener,
      }) as unknown as MediaQueryList,
  );
  window.matchMedia = matchMedia;
  return { matchMedia, addEventListener, removeEventListener };
};

const Probe: React.FC<{ tick: number }> = ({ tick }) => (
  <span>{`${String(useMediaQuery(WIDE_LAYOUT_QUERY))}:${tick}`}</span>
);

afterEach(() => {
  window.matchMedia = original;
});

describe('useMediaQuery', () => {
  it('subscribes once however often the component re-renders', () => {
    const media = stubMatchMedia();
    const view = render(<Probe tick={0} />);

    view.rerender(<Probe tick={1} />);
    view.rerender(<Probe tick={2} />);

    expect(media.matchMedia).toHaveBeenCalledTimes(1);
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    expect(media.removeEventListener).not.toHaveBeenCalled();
  });

  it('swaps the subscription when the query changes', () => {
    const media = stubMatchMedia();
    const Switcher: React.FC<{ query: string }> = ({ query }) => (
      <span>{String(useMediaQuery(query))}</span>
    );
    const view = render(<Switcher query="(min-width: 100px)" />);

    view.rerender(<Switcher query="(min-width: 200px)" />);

    expect(media.matchMedia.mock.calls.map(([query]) => query)).toEqual([
      '(min-width: 100px)',
      '(min-width: 200px)',
    ]);
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
    expect(media.addEventListener).toHaveBeenCalledTimes(2);
  });
});
