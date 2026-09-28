/**
 * URL helpers. `canonicalUrlKey` is the single dedup key for resources; `urlKey` is recomputed on
 * every load (`normalizeResource`), so changing the normalization needs no migration.
 */

// `ref` stays out of this list: GitLab/GitHub use `?ref=<branch>` for distinct pages.
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_eid', 'ref_src']);
const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

const isHttp = (protocol: string): boolean => protocol === 'http:' || protocol === 'https:';

/**
 * Single http(s) parser: `null` for anything that is not an absolute http(s) URL with a host.
 * With `assumeHttps` off, scheme-less input is rejected instead of being prefixed.
 */
export const parseHttpUrl = (
  input: string,
  options: { assumeHttps?: boolean } = {},
): URL | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // A scheme without `//` (mailto, javascript, …), but not `host:port`.
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/|\d)/i.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (!hasScheme && options.assumeHttps === false) return null;
  try {
    const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    return isHttp(parsed.protocol) && parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
};

export interface NormalizeUrlOptions {
  /** Accept a dotless host (intranet names) only when the scheme is spelled out explicitly. */
  allowDotlessHost?: boolean;
}

/** Validates user input and returns an absolute http(s) URL, or `null`. */
export const normalizeInputUrl = (
  input: string,
  options: NormalizeUrlOptions = {},
): string | null => {
  const parsed = parseHttpUrl(input);
  if (!parsed) return null;
  // Reject dotless hosts unless localhost or an IP literal.
  const host = parsed.hostname;
  if (!host.includes('.') && host !== 'localhost' && !host.startsWith('[')) {
    const explicitScheme = /^https?:\/\//i.test(input.trim());
    if (!(options.allowDotlessHost && explicitScheme)) return null;
  }
  return parsed.toString();
};

/** True when the value is an absolute http(s) URL. */
export const isHttpUrl = (value: string | undefined | null): boolean => {
  if (!value) return false;
  try {
    return isHttp(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Hostname without a leading `www.`; empty string for invalid input. */
export const hostOf = (url: string): string => {
  const parsed = parseHttpUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./i, '') : '';
};

/**
 * Canonical dedup key: scheme, `www.`, anchor fragment, default port, trailing slash and tracking
 * params dropped, query sorted; invalid input falls back to the trimmed lowercase string.
 */
export const canonicalUrlKey = (url: string): string => {
  const parsed = parseHttpUrl(url);
  if (!parsed) return url.trim().toLowerCase();

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const port =
    parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';

  const params = [...parsed.searchParams.entries()].filter(([key]) => {
    const lower = key.toLowerCase();
    return !lower.startsWith('utm_') && !TRACKING_PARAMS.has(lower);
  });
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';

  let path = parsed.pathname;
  while (path.length > 0 && path.endsWith('/')) path = path.slice(0, -1);

  // `#/…` and `#!…` are hash-router pages, not anchors within one page.
  const route = /^#[!/]/.test(parsed.hash) ? parsed.hash : '';

  return `${host}${port}${path}${query}${route}`;
};

/** True when the address carries a `user:password@` part. */
export const hasCredentials = (url: string): boolean => {
  const parsed = parseHttpUrl(url);
  return parsed !== null && (parsed.username !== '' || parsed.password !== '');
};

/** The same address without its `user:password@` part. */
export const stripCredentials = (url: string): string => {
  const parsed = parseHttpUrl(url);
  if (!parsed || (!parsed.username && !parsed.password)) return url;
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
};

/**
 * Host (without `www.`), path and query for display, e.g. `example.com/docs/en`. Credentials are
 * dropped and a non-https scheme is spelled out, because that is the part worth noticing.
 */
export const shortAddress = (url: string): string => {
  const parsed = parseHttpUrl(url);
  if (!parsed) return url.trim();
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  const scheme = parsed.protocol === 'https:' ? '' : `${parsed.protocol}//`;
  return `${scheme}${parsed.host.replace(/^www\./i, '')}${path}${parsed.search}`;
};

/** True when a title is empty or merely repeats the URL / host. */
export const looksLikeUrl = (title: string, url: string): boolean => {
  const value = title.trim().toLowerCase();
  if (!value) return true;
  if (/^https?:\/\//.test(value)) return true;
  const host = hostOf(url).toLowerCase();
  return (
    value === host || value === `www.${host}` || canonicalUrlKey(value) === canonicalUrlKey(url)
  );
};
