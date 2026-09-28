import { useLayoutEffect, useState, type RefObject } from 'react';

export interface ScrollViewport {
  /** The list's own width; `0` unless `trackWidth` is on. */
  width: number;
  scrollTop: number;
  height: number;
  /** Distance from the scroll container's content top to the list's top. */
  offsetTop: number;
}

const INITIAL: ScrollViewport = { width: 0, scrollTop: 0, height: 800, offsetTop: 0 };

/** Frames to wait for the container to attach before giving up. */
const MAX_MEASURE_ATTEMPTS = 10;

/**
 * Measures a windowed list against the scroll container above it, re-measuring on scroll and
 * resize. `measureAttempt` counts the frames spent waiting for the container ref to attach.
 */
export const useScrollViewport = (
  scrollContainerRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  options: {
    /** Measure the list's width and observe the list itself (column counts depend on it). */
    trackWidth?: boolean;
  } = {},
): { viewport: ScrollViewport; measureAttempt: number } => {
  const { trackWidth = false } = options;
  const [measureAttempt, setMeasureAttempt] = useState(0);
  const [viewport, setViewport] = useState<ScrollViewport>(INITIAL);

  useLayoutEffect(() => {
    const scrollEl = scrollContainerRef.current;
    const listEl = listRef.current;
    if (!listEl) return;
    if (!scrollEl) {
      if (measureAttempt >= MAX_MEASURE_ATTEMPTS) return undefined;
      // Ancestor refs attach after descendant layout effects; retry each frame until it is there.
      const retry = window.requestAnimationFrame(() => setMeasureAttempt((n) => n + 1));
      return () => window.cancelAnimationFrame(retry);
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const next: ScrollViewport = {
        width: trackWidth ? listEl.clientWidth : 0,
        scrollTop: scrollEl.scrollTop,
        height: scrollEl.clientHeight,
        offsetTop:
          listEl.getBoundingClientRect().top -
          scrollEl.getBoundingClientRect().top +
          scrollEl.scrollTop,
      };
      setViewport((prev) =>
        prev.width === next.width &&
        prev.scrollTop === next.scrollTop &&
        prev.height === next.height &&
        prev.offsetTop === next.offsetTop
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    measure();
    scrollEl.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollEl);
    if (trackWidth) observer.observe(listEl);
    return () => {
      scrollEl.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [scrollContainerRef, listRef, trackWidth, measureAttempt]);

  return { viewport, measureAttempt };
};
