/**
 * Pure, deterministic media derivation; nothing here is written to the store. Remote URLs are
 * never rendered directly; only cached asset/data URLs reach an <img>.
 */
import type { MediaPatch, Resource, ResourceMedia } from '../types';
import { escapeHtml } from '../lib/export';
import { hostOf } from '../lib/url';
import {
  DEFAULT_GRADIENT,
  PLACEHOLDER_FONT_STACK,
  PLACEHOLDER_GRADIENTS,
  PLACEHOLDER_INK,
  type Gradient,
} from '../lib/theme';
import { snapshotSrc as defaultSnapshotSrc } from './snapshots';

const copyDefined = <K extends keyof ResourceMedia>(
  out: ResourceMedia,
  from: MediaPatch,
  key: K,
  dropFalse: boolean,
): void => {
  const value = from[key];
  if (value === undefined || (dropFalse && value === false)) return;
  out[key] = value;
};

/** Merges a media patch; keys ending `undefined` (or `false` with `dropFalse`) are left out. */
export const applyMediaPatch = (
  media: ResourceMedia,
  patch: MediaPatch,
  { dropFalse = false }: { dropFalse?: boolean } = {},
): ResourceMedia => {
  const merged: MediaPatch = { ...media, ...patch };
  const out: ResourceMedia = {};
  for (const key of Object.keys(merged) as (keyof ResourceMedia)[]) {
    copyDefined(out, merged, key, dropFalse);
  }
  return out;
};

/** Shallow equality of two media records, so a patch that changes nothing can be dropped. */
export const sameMedia = (a: ResourceMedia, b: ResourceMedia): boolean => {
  const keys = Object.keys(a) as (keyof ResourceMedia)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const gradientFor = (seed: string): Gradient =>
  PLACEHOLDER_GRADIENTS[hashSeed(seed) % PLACEHOLDER_GRADIENTS.length] ?? DEFAULT_GRADIENT;

const MAX_SVG_CACHE = 2000;
const svgCache = new Map<string, string>();

const memo = (key: string, build: () => string): string => {
  const cached = svgCache.get(key);
  if (cached !== undefined) return cached;
  const value = build();
  if (svgCache.size >= MAX_SVG_CACHE) svgCache.clear();
  svgCache.set(key, value);
  return value;
};

const hashSeed = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const toDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Image URLs the app renders: local asset URLs and data:image URIs only. */
export const isAllowedImageSrc = (value: string | undefined | null): value is string => {
  if (!value) return false;
  if (value.startsWith('data:image/')) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'asset:' || parsed.hostname === 'asset.localhost';
};

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The label that names the site: `rust-lang` in `docs.rust-lang.org`, `bbc` in `bbc.co.uk`. */
const siteLabel = (host: string): string => {
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] ?? '';
  const [suffix, second] = [labels.at(-1) ?? '', labels.at(-2) ?? ''];
  // Two short trailing labels are a country suffix such as `co.uk` or `com.tr`.
  const countrySuffix = labels.length > 2 && suffix.length <= 3 && second.length <= 3;
  return (countrySuffix ? labels.at(-3) : second) ?? '';
};

/**
 * One-letter monogram: the site name for a domain host, else the first real word of the title;
 * '' when neither exists (IP host, numeric title), which draws a neutral globe.
 */
export const monogramFor = (url: string, title: string): string => {
  const host = hostOf(url).toLocaleLowerCase();
  if (host && !IPV4_HOST.test(host) && !host.startsWith('[') && /\p{L}/u.test(host)) {
    const first = siteLabel(host).match(/[\p{L}\p{N}]/u)?.[0];
    if (first) return first.toLocaleUpperCase();
  }
  const word = title.split(/[^\p{L}\p{N}]+/u).find((part) => /^\p{L}{2,}$/u.test(part));
  return word ? word.charAt(0).toLocaleUpperCase() : '';
};

/** SVG markup for the monogram, or a simple globe drawn around (cx, cy) with radius r. */
const glyphSvg = (
  monogram: string,
  { cx, cy, r, fontSize }: { cx: number; cy: number; r: number; fontSize: number },
): string =>
  monogram
    ? `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="${PLACEHOLDER_INK.glyph}" font-family="${PLACEHOLDER_FONT_STACK}" font-size="${fontSize}" font-weight="700">${escapeHtml(monogram)}</text>`
    : `<g fill="none" stroke="${PLACEHOLDER_INK.globe}" stroke-width="${r / 7}"><circle cx="${cx}" cy="${cy}" r="${r}"/><ellipse cx="${cx}" cy="${cy}" rx="${r * 0.45}" ry="${r}"/><path d="M${cx - r} ${cy}H${cx + r}"/></g>`;

/** Generated gradient cover with a monogram + host. */
const coverSvg = (url: string, label: string): string => {
  const host = hostOf(url) || 'mynk';
  return memo(`cover|${host}|${label}`, () => {
    const gradient = gradientFor(`${host}-${label}`);
    const glyph = glyphSvg(monogramFor(url, label), { cx: 600, cy: 410, r: 90, fontSize: 170 });
    const svg = `<svg width="1200" height="800" viewBox="0 0 1200 800" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${gradient.start}"/><stop offset="100%" stop-color="${gradient.end}"/></linearGradient></defs>
<rect width="1200" height="800" fill="url(#bg)"/>
<circle cx="1040" cy="-120" r="360" fill="${PLACEHOLDER_INK.sheen}"/>
<circle cx="120" cy="760" r="300" fill="${PLACEHOLDER_INK.sheenSoft}"/>
${glyph}
<text x="600" y="525" text-anchor="middle" dominant-baseline="middle" fill="${PLACEHOLDER_INK.host}" font-family="${PLACEHOLDER_FONT_STACK}" font-size="42" font-weight="500">${escapeHtml(host)}</text>
</svg>`;
    return toDataUri(svg);
  });
};

/** Letter avatar used when no real favicon is known (or it fails to load). */
const letterAvatarSvg = (url: string, title: string): string => {
  const host = hostOf(url) || 'mynk';
  const monogram = monogramFor(url, title);
  return memo(`avatar|${host}|${monogram}`, () => {
    const gradient = gradientFor(`${host}-favicon`);
    const glyph = glyphSvg(monogram, { cx: 32, cy: 35, r: 14, fontSize: 28 });
    const svg = `<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="fg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${gradient.start}"/><stop offset="100%" stop-color="${gradient.end}"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#fg)"/>
${glyph}
</svg>`;
    return toDataUri(svg);
  });
};

/** True while a remote og:image / favicon is known but has not been cached yet. */
export const needsRemoteMediaCache = (resource: Resource): boolean => {
  const { faviconUrl, faviconFile, imageUrl, imageFile, remoteCachedAt } = resource.media;
  if (remoteCachedAt !== undefined) return false;
  return Boolean((imageUrl && !imageFile) || (faviconUrl && !faviconFile));
};

/** True when a real preview image is known; a still-caching og:image counts too (avoids a race). */
export const hasPreview = (resource: Resource): boolean => {
  const { uploadedFile, snapshotFile, imageFile, imageUrl, remoteCachedAt } = resource.media;
  return Boolean(
    uploadedFile || snapshotFile || imageFile || (imageUrl && remoteCachedAt === undefined),
  );
};

/** Media fields that name a file in the snapshot directory. */
export const MEDIA_FILE_KEYS = [
  'snapshotFile',
  'uploadedFile',
  'faviconFile',
  'imageFile',
] as const;

/** Every snapshot-directory file the resource references (keep-list for maintenance). */
export const mediaFilesOf = (resource: Resource): string[] =>
  MEDIA_FILE_KEYS.map((key) => resource.media[key]).filter((f): f is string => Boolean(f));

/** Ordered preview candidates; `snapshotSrc` returns '' before the snapshot dir is known. */
export const previewSources = (
  resource: Resource,
  snapshotSrc: (fileName: string) => string,
): string[] => {
  const { uploadedFile, snapshotFile, imageFile } = resource.media;
  const candidates = [uploadedFile, snapshotFile, imageFile]
    .map((file) => (file ? snapshotSrc(file) : ''))
    .filter(isAllowedImageSrc);
  candidates.push(coverSvg(resource.url, resource.title));
  return [...new Set(candidates)];
};

/** Favicon candidates: cached favicon → letter avatar, used until `initSnapshotDir()`. */
export const faviconSources = (
  resource: Resource,
  snapshotSrc: (fileName: string) => string = defaultSnapshotSrc,
): string[] => {
  const list: string[] = [];
  const { faviconFile } = resource.media;
  const cached = faviconFile ? snapshotSrc(faviconFile) : '';
  if (isAllowedImageSrc(cached)) list.push(cached);
  list.push(letterAvatarSvg(resource.url, resource.title));
  return list;
};

/** Display label for the source of a resource (derived, never stored). */
export const sourceLabel = (resource: Pick<Resource, 'url'>): string =>
  hostOf(resource.url) || resource.url;
