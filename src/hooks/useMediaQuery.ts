import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Live `window.matchMedia(query).matches`. */
export const useMediaQuery = (query: string): boolean => {
  // One list per query: a new one on every render would re-subscribe the store on every render.
  const list = useMemo(
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query)
        : null,
    [query],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!list) return () => undefined;
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [list],
  );
  const getSnapshot = useCallback(() => list?.matches ?? false, [list]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
};

/** Wide windows dock the inspector next to the content instead of overlaying it. */
export const WIDE_LAYOUT_QUERY = '(min-width: 1440px)';
export const PREFERS_LIGHT_QUERY = '(prefers-color-scheme: light)';
