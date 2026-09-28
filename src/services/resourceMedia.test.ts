import { describe, expect, it } from 'vitest';
import { createResource } from '../store/model';
import type { Resource, ResourceMedia } from '../types';
import { makeResource } from '../test/fixtures';
import {
  faviconSources,
  hasPreview,
  isAllowedImageSrc,
  mediaFilesOf,
  monogramFor,
  needsRemoteMediaCache,
  previewSources,
} from './resourceMedia';

const withMedia = (media: ResourceMedia): Resource => {
  const resource = createResource({ url: 'https://example.com/page', title: 'Example' });
  if (!resource) throw new Error('fixture');
  return { ...resource, media };
};

const toSrc = (fileName: string) => `http://asset.localhost/cache/${fileName}`;

describe('resourceMedia (local-only images)', () => {
  it('never allows remote http(s) image URLs', () => {
    expect(isAllowedImageSrc('https://example.com/a.png')).toBe(false);
    expect(isAllowedImageSrc('http://example.com/a.png')).toBe(false);
    expect(isAllowedImageSrc('http://asset.localhost/x.png')).toBe(true);
    expect(isAllowedImageSrc('asset://localhost/x.png')).toBe(true);
    expect(isAllowedImageSrc('data:image/svg+xml,<svg/>')).toBe(true);
    expect(isAllowedImageSrc('javascript:alert(1)')).toBe(false);
  });

  it('orders previews uploaded → snapshot → cached og:image → generated cover', () => {
    const resource = withMedia({
      uploadedFile: 'upload-a.png',
      snapshotFile: 'snap.png',
      imageFile: 'img-1.jpg',
      imageUrl: 'https://example.com/og.jpg',
    });
    const sources = previewSources(resource, toSrc);
    expect(sources.slice(0, 3)).toEqual([
      toSrc('upload-a.png'),
      toSrc('snap.png'),
      toSrc('img-1.jpg'),
    ]);
    expect(sources[3]).toMatch(/^data:image\/svg\+xml/);
    expect(sources.some((s) => s.startsWith('https://'))).toBe(false);
  });

  it('does not render an uncached og:image URL', () => {
    const sources = previewSources(withMedia({ imageUrl: 'https://example.com/og.jpg' }), toSrc);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/^data:image\/svg\+xml/);
  });

  it('skips files before the snapshot dir is known', () => {
    const sources = previewSources(withMedia({ snapshotFile: 'snap.png' }), () => '');
    expect(sources).toHaveLength(1);
  });

  it('favicon: cached file → letter avatar, never the remote URL', () => {
    const cached = faviconSources(
      withMedia({ faviconUrl: 'https://example.com/favicon.ico', faviconFile: 'fav-1.ico' }),
      toSrc,
    );
    expect(cached[0]).toBe(toSrc('fav-1.ico'));
    expect(cached[1]).toMatch(/^data:image\/svg\+xml/);

    const uncached = faviconSources(withMedia({ faviconUrl: 'https://example.com/favicon.ico' }));
    expect(uncached).toHaveLength(1);
    expect(uncached[0]).toMatch(/^data:image\/svg\+xml/);
  });

  it('hasPreview counts an og:image only while it is cached or still pending', () => {
    expect(hasPreview(withMedia({}))).toBe(false);
    expect(hasPreview(withMedia({ imageFile: 'img-1.jpg' }))).toBe(true);
    expect(hasPreview(withMedia({ imageUrl: 'https://example.com/og.jpg' }))).toBe(true);
    expect(
      hasPreview(withMedia({ imageUrl: 'https://example.com/og.jpg', remoteCachedAt: 1 })),
    ).toBe(false);
  });

  it('needsRemoteMediaCache and mediaFilesOf', () => {
    expect(needsRemoteMediaCache(withMedia({ faviconUrl: 'https://e.com/f.ico' }))).toBe(true);
    expect(
      needsRemoteMediaCache(withMedia({ faviconUrl: 'https://e.com/f.ico', faviconFile: 'f.ico' })),
    ).toBe(false);
    expect(
      needsRemoteMediaCache(withMedia({ imageUrl: 'https://e.com/o.png', remoteCachedAt: 5 })),
    ).toBe(false);
    expect(
      mediaFilesOf(
        withMedia({ snapshotFile: 's.png', uploadedFile: 'u.png', faviconFile: 'f.ico' }),
      ),
    ).toEqual(['s.png', 'u.png', 'f.ico']);
  });
});

describe('monogramFor', () => {
  it('names the site for a domain host', () => {
    expect(monogramFor('https://github.com/x', 'Anything')).toBe('G');
    expect(monogramFor('https://docs.rust-lang.org/book/', '')).toBe('R');
    expect(monogramFor('https://www.bbc.co.uk/news', '')).toBe('B');
    expect(monogramFor('http://wiki/start', '')).toBe('W');
  });

  it('uses the first real word of the title for an IP host, else a neutral glyph', () => {
    expect(monogramFor('http://127.0.0.1:8899/page/1', '127.0.0.1')).toBe('');
    expect(monogramFor('http://127.0.0.1:8899/page/1', 'Imported 1992 page')).toBe('I');
    expect(monogramFor('http://10.0.0.5/', '2024 report')).toBe('R');
    expect(monogramFor('http://[::1]:3000/', '')).toBe('');
  });

  it('draws a globe instead of digits when there is no monogram', () => {
    const [avatar] = faviconSources(makeResource({ url: 'http://127.0.0.1/', title: '127.0.0.1' }));
    const svg = decodeURIComponent(avatar ?? '');
    expect(svg).toContain('<ellipse');
    expect(svg).not.toContain('<text');
  });
});
