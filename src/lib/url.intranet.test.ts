import { describe, expect, it } from 'vitest';
import { canonicalUrlKey, normalizeInputUrl } from './url';

describe('normalizeInputUrl: hosts without a dot', () => {
  it('keeps rejecting them for typed input (the default)', () => {
    expect(normalizeInputUrl('wiki')).toBeNull();
    expect(normalizeInputUrl('http://wiki/')).toBeNull();
  });

  it('accepts intranet hosts for imports when the scheme is explicit', () => {
    const opts = { allowDotlessHost: true };
    expect(normalizeInputUrl('http://wiki/', opts)).toBe('http://wiki/');
    expect(normalizeInputUrl('http://jira/browse/X-1', opts)).toBe('http://jira/browse/X-1');
    expect(normalizeInputUrl('  HTTPS://intranet:8443/a ', opts)).toBe('https://intranet:8443/a');
    // Without a scheme a dotless name is treated as a typo.
    expect(normalizeInputUrl('wiki', opts)).toBeNull();
    expect(normalizeInputUrl('javascript:alert(1)', opts)).toBeNull();
  });
});

describe('canonicalUrlKey: ref parameter', () => {
  it('keeps `ref` so branch-specific pages stay distinct', () => {
    const v1 = canonicalUrlKey('https://gitlab.com/group/project/-/tree?ref=v1');
    const v2 = canonicalUrlKey('https://gitlab.com/group/project/-/tree?ref=v2');
    expect(v1).not.toBe(v2);
    expect(v1).toBe('gitlab.com/group/project/-/tree?ref=v1');
  });

  it('still drops ref_src and the other tracking parameters', () => {
    expect(canonicalUrlKey('https://example.com/a?ref_src=twsrc&utm_source=x')).toBe(
      'example.com/a',
    );
  });
});
