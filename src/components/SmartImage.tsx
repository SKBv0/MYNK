import React, { useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cx } from './ui';

interface SmartImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** Ordered candidates; the next one is tried when a source fails to load. */
  sources: ReadonlyArray<string | undefined | null>;
  /** Rendered when every source failed. Defaults to a neutral placeholder that keeps `alt`. */
  fallback?: React.ReactNode;
}

// Remembers failing URLs for a while so lists don't retry broken images on every mount.
const FAILED_TTL_MS = 10 * 60 * 1000;
const FAILED_MAX = 500;
const failedSources = new Map<string, number>();
/** URLs that already loaded once: no skeleton flash when a card remounts. */
const loadedSources = new Set<string>();
const LOADED_MAX = 2000;

const hasFailed = (src: string): boolean => {
  const at = failedSources.get(src);
  if (at === undefined) return false;
  if (Date.now() - at > FAILED_TTL_MS) {
    failedSources.delete(src);
    return false;
  }
  return true;
};

const markFailed = (src: string) => {
  failedSources.delete(src);
  failedSources.set(src, Date.now());
  while (failedSources.size > FAILED_MAX) {
    const oldest = failedSources.keys().next().value;
    if (oldest === undefined) break;
    failedSources.delete(oldest);
  }
};

const markLoaded = (src: string) => {
  loadedSources.delete(src);
  loadedSources.add(src);
  while (loadedSources.size > LOADED_MAX) {
    const oldest = loadedSources.values().next().value;
    if (oldest === undefined) break;
    loadedSources.delete(oldest);
  }
};

const firstUsable = (sources: string[], from: number): number => {
  for (let i = from; i < sources.length; i += 1) {
    const source = sources[i];
    if (source !== undefined && !hasFailed(source)) return i;
  }
  return -1;
};

/** Image with fallback chain, a loading skeleton and a placeholder when every source failed. */
const SmartImage: React.FC<SmartImageProps> = ({
  sources,
  fallback,
  onError,
  onLoad,
  alt = '',
  className,
  decoding = 'async',
  ...imgProps
}) => {
  const list = useMemo(
    () => [...new Set(sources.map((s) => s?.trim()).filter((s): s is string => Boolean(s)))],
    [sources],
  );
  const listKey = list.join('\n');

  // Reset the position when the candidate list changes (derived state, no effect needed).
  const [state, setState] = useState(() => ({ key: listKey, index: firstUsable(list, 0) }));
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  let index = state.index;
  if (state.key !== listKey) {
    index = firstUsable(list, 0);
    setState({ key: listKey, index });
  }

  const src = index >= 0 ? list[index] : undefined;
  if (!src) {
    return (
      <>
        {fallback ?? (
          <div
            role={alt ? 'img' : undefined}
            aria-label={alt || undefined}
            aria-hidden={alt ? undefined : true}
            className={cx('flex items-center justify-center bg-surface-3 text-fg-muted', className)}
          >
            <ImageOff size={18} aria-hidden />
          </div>
        )}
      </>
    );
  }

  const isLoaded = loadedSrc === src || loadedSources.has(src);

  return (
    <img
      {...imgProps}
      alt={alt}
      src={src}
      decoding={decoding}
      className={cx(className, !isLoaded && 'animate-pulse bg-surface-3')}
      onLoad={(event) => {
        markLoaded(src);
        setLoadedSrc(src);
        onLoad?.(event);
      }}
      onError={(event) => {
        markFailed(src);
        setState({ key: listKey, index: firstUsable(list, index + 1) });
        onError?.(event);
      }}
    />
  );
};

export default SmartImage;
