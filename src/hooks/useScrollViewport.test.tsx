import React, { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useScrollViewport } from './useScrollViewport';

/** A list whose scroll container never attaches. */
const Orphan: React.FC = () => {
  const missing = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const { measureAttempt } = useScrollViewport(missing, list);
  return <div ref={list} data-testid="attempts" data-attempts={measureAttempt} />;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScrollViewport', () => {
  it('gives up after a bounded number of frames', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const view = render(<Orphan />);
    for (let i = 0; i < 50 && frames.length > 0; i += 1) {
      const next = frames.shift();
      if (next) next(0);
      await waitFor(() => expect(view.getByTestId('attempts')).toBeInTheDocument());
    }

    const attempts = Number(view.getByTestId('attempts').dataset.attempts);
    expect(frames).toHaveLength(0);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(10);
  });
});
