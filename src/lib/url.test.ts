import { describe, expect, it } from 'vitest';
import { canonicalUrlKey, hostOf, looksLikeUrl, normalizeInputUrl, shortAddress } from './url';

describe('canonicalUrlKey', () => {
  const same = (a: string, b: string) => expect(canonicalUrlKey(a)).toBe(canonicalUrlKey(b));

  it('ignores the scheme (http vs https)', () => {
    same('http://example.com/a', 'https://example.com/a');
  });

  it('lowercases the host and drops www.', () => {
    same('https://WWW.Example.COM/Path', 'https://example.com/Path');
    expect(canonicalUrlKey('https://example.com/Path')).toBe('example.com/Path');
  });

  it('keeps path case (paths are case-sensitive)', () => {
    expect(canonicalUrlKey('https://example.com/Path')).not.toBe(
      canonicalUrlKey('https://example.com/path'),
    );
  });

  it('removes default ports but keeps custom ones', () => {
    same('https://example.com:443/a', 'https://example.com/a');
    same('http://example.com:80/a', 'http://example.com/a');
    expect(canonicalUrlKey('https://example.com:8443/a')).toBe('example.com:8443/a');
  });

  it('drops an anchor fragment', () => {
    same('https://example.com/a#section-2', 'https://example.com/a');
  });

  it('keeps a hash-router route, so two app pages stay two bookmarks', () => {
    expect(canonicalUrlKey('https://app.example.com/#/reports')).toBe('app.example.com#/reports');
    expect(canonicalUrlKey('https://app.example.com/#!/settings')).toBe(
      'app.example.com#!/settings',
    );
    expect(canonicalUrlKey('https://app.example.com/#/reports')).not.toBe(
      canonicalUrlKey('https://app.example.com/#/settings'),
    );
  });

  it('removes tracking parameters', () => {
    same(
      'https://example.com/a?utm_source=x&utm_medium=y&fbclid=1&gclid=2&mc_eid=3&ref_src=5',
      'https://example.com/a',
    );
    expect(canonicalUrlKey('https://example.com/a?id=7&utm_campaign=z')).toBe('example.com/a?id=7');
  });

  it('sorts the remaining query parameters', () => {
    same('https://example.com/search?b=2&a=1', 'https://example.com/search?a=1&b=2');
  });

  it('removes trailing slashes', () => {
    same('https://example.com/docs/', 'https://example.com/docs');
    same('https://example.com/', 'https://example.com');
    expect(canonicalUrlKey('https://example.com/')).toBe('example.com');
  });

  it('accepts input without a scheme', () => {
    same('example.com/a', 'https://example.com/a');
  });

  it('normalizes internationalized hosts to punycode', () => {
    same('https://BÜCHER.de/', 'https://xn--bcher-kva.de');
  });

  it('falls back to the trimmed lowercase string for invalid input', () => {
    expect(canonicalUrlKey('  Not A URL  ')).toBe('not a url');
  });
});

describe('normalizeInputUrl', () => {
  it('adds https:// and validates the host', () => {
    expect(normalizeInputUrl('example.com')).toBe('https://example.com/');
    expect(normalizeInputUrl('  https://example.com/x ')).toBe('https://example.com/x');
  });

  it('rejects non-http protocols and bogus hosts', () => {
    expect(normalizeInputUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeInputUrl('ftp://example.com')).toBeNull();
    expect(normalizeInputUrl('hello')).toBeNull();
    expect(normalizeInputUrl('')).toBeNull();
  });

  it('allows localhost', () => {
    expect(normalizeInputUrl('http://localhost:3000')).toBe('http://localhost:3000/');
  });
});

describe('hostOf / looksLikeUrl', () => {
  it('returns the host without www', () => {
    expect(hostOf('https://www.github.com/x')).toBe('github.com');
    expect(hostOf('')).toBe('');
    expect(hostOf('mailto:x@y.com')).toBe('');
  });

  it('detects titles that merely repeat the URL', () => {
    expect(looksLikeUrl('', 'https://a.com')).toBe(true);
    expect(looksLikeUrl('a.com', 'https://www.a.com/')).toBe(true);
    expect(looksLikeUrl('https://a.com/x', 'https://a.com/x')).toBe(true);
    expect(looksLikeUrl('A real title', 'https://a.com')).toBe(false);
  });
});

describe('shortAddress', () => {
  it('shows host, path and query without the scheme or www', () => {
    expect(shortAddress('https://www.example.com/docs/en?v=2')).toBe('example.com/docs/en?v=2');
    expect(shortAddress('http://wiki:8080/')).toBe('http://wiki:8080');
  });
});
