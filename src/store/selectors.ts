/**
 * Pure selectors over the library. Single source for search, keyword (smart collection)
 * matching, collection counts and the health summary.
 */
import type { CategoryId, Collection, Resource } from '../types';
import { hostOf } from '../lib/url';
import { normalizeSearchText, tokenize } from '../lib/text';
import { hasPreview } from '../services/resourceMedia';
import { scopeCollectionId, type Scope, type ViewMode } from '../lib/nav';

interface SearchFields {
  all: string;
  title: string;
  host: string;
  tags: string;
}

/** Keyed on the record object, so a rewritten record recomputes and an old one is collected. */
const fieldCache = new WeakMap<Resource, SearchFields>();

const searchFields = (resource: Resource): SearchFields => {
  const cached = fieldCache.get(resource);
  if (cached) return cached;
  const title = normalizeSearchText(resource.title);
  const host = normalizeSearchText(hostOf(resource.url));
  const tags = normalizeSearchText(resource.tags.join(' '));
  const all = [
    title,
    normalizeSearchText(resource.description),
    normalizeSearchText(resource.url),
    host,
    tags,
    normalizeSearchText(resource.summary.join(' ')),
    normalizeSearchText(resource.folderPath.join(' ')),
  ].join('\n');
  const fields = { all, title, host, tags };
  fieldCache.set(resource, fields);
  return fields;
};

const keywordHaystack = (resource: Resource): string => searchFields(resource).all;

const MAX_REGEX_CACHE = 256;
const regexCache = new Map<string, RegExp | null>();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compiles keywords into one RegExp that matches at the start of a token, so "yazılım"
 * matches "yazılımcılar" and "react" matches "react-native", but "ai" does not match "email".
 */
const compileKeywords = (keywords: readonly string[]): RegExp | null => {
  const cacheKey = JSON.stringify(keywords);
  if (regexCache.has(cacheKey)) return regexCache.get(cacheKey) ?? null;
  const parts = keywords
    .map((keyword) => normalizeSearchText(keyword.trim()))
    .filter(Boolean)
    .map(escapeRegExp);
  const regex =
    parts.length > 0 ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${parts.join('|')})`, 'u') : null;
  if (regexCache.size >= MAX_REGEX_CACHE) regexCache.clear();
  regexCache.set(cacheKey, regex);
  return regex;
};

export const matchesKeywords = (resource: Resource, keywords: readonly string[]): boolean => {
  const regex = compileKeywords(keywords);
  return regex ? regex.test(keywordHaystack(resource)) : false;
};

/** A collection's membership test, prepared once: pinned ids as a Set, keywords as one RegExp. */
interface MembershipRule {
  key: string;
  pinned: Set<string>;
  regex: RegExp | null;
}

const ruleCache = new WeakMap<Collection, MembershipRule>();

const membershipRule = (collection: Collection): MembershipRule => {
  let rule = ruleCache.get(collection);
  if (!rule) {
    rule = {
      key: `${collection.keywords.join('\0')}|${collection.pinnedIds.join('\0')}`,
      pinned: new Set(collection.pinnedIds),
      regex: compileKeywords(collection.keywords),
    };
    ruleCache.set(collection, rule);
  }
  return rule;
};

const membershipCache = new WeakMap<Resource, Map<string, boolean>>();

/** Every pin toggle and keyword chip mints a new rule key, so the per-record map is capped. */
const MAX_RULES_PER_RESOURCE = 8;

/** Memoized per record, so a bulk write only re-tests the records it rewrote. */
const memberByRule = (resource: Resource, rule: MembershipRule): boolean => {
  let byRule = membershipCache.get(resource);
  if (!byRule) {
    byRule = new Map();
    membershipCache.set(resource, byRule);
  }
  let member = byRule.get(rule.key);
  if (member === undefined) {
    member =
      rule.pinned.has(resource.id) ||
      (rule.regex !== null && rule.regex.test(keywordHaystack(resource)));
    if (byRule.size >= MAX_RULES_PER_RESOURCE) byRule.clear();
    byRule.set(rule.key, member);
  }
  return member;
};

/** Test hook: how many rule answers this record currently caches. */
export const cachedRuleCount = (resource: Resource): number =>
  membershipCache.get(resource)?.size ?? 0;

export const isCollectionMember = (resource: Resource, collection: Collection): boolean =>
  memberByRule(resource, membershipRule(collection));

export const countCollectionMembers = (collection: Collection, resources: Resource[]): number => {
  const rule = membershipRule(collection);
  let count = 0;
  for (const resource of resources) if (memberByRule(resource, rule)) count += 1;
  return count;
};

export const collectionMembers = (collection: Collection, resources: Resource[]): Resource[] => {
  const rule = membershipRule(collection);
  return resources.filter((resource) => memberByRule(resource, rule));
};

export interface ResourceFilter {
  query?: string;
  collection?: Collection | null;
  favoritesOnly?: boolean;
}

interface PreparedFilter {
  tokens: string[];
  rule: MembershipRule | null;
  favoritesOnly: boolean;
}

/** `null` when the filter excludes nothing, which is what lets the input array pass through. */
const prepareFilter = (filter: ResourceFilter): PreparedFilter | null => {
  const tokens = tokenize(filter.query ?? '');
  const collection = filter.collection ?? null;
  const favoritesOnly = filter.favoritesOnly ?? false;
  if (tokens.length === 0 && !collection && !favoritesOnly) return null;
  return { tokens, rule: collection ? membershipRule(collection) : null, favoritesOnly };
};

const matchesPrepared = (resource: Resource, prepared: PreparedFilter): boolean => {
  if (prepared.favoritesOnly && !resource.isFavorite) return false;
  if (prepared.rule && !memberByRule(resource, prepared.rule)) return false;
  if (prepared.tokens.length === 0) return true;
  const haystack = searchFields(resource).all;
  return prepared.tokens.every((token) => haystack.includes(token));
};

/** Case/diacritic-insensitive AND search over title, description, URL, host, tags, summary. */
export const filterResources = (resources: Resource[], filter: ResourceFilter): Resource[] => {
  const prepared = prepareFilter(filter);
  if (!prepared) return resources;
  return resources.filter((resource) => matchesPrepared(resource, prepared));
};

const filterKeyOf = (filter: ResourceFilter): string =>
  [
    filter.query ?? '',
    filter.favoritesOnly ? '1' : '0',
    filter.collection?.id ?? '',
    filter.collection?.keywords.join(',') ?? '',
    filter.collection?.pinnedIds.join(',') ?? '',
  ].join('\0');

/** The filter answer each record gave last, keyed on the record so a rewrite invalidates it. */
const filterHits = new WeakMap<Resource, { key: string; matched: boolean }>();

/** `filterResources` that only re-tests the records a write replaced. */
export const filterMemoized = (resources: Resource[], filter: ResourceFilter): Resource[] => {
  const prepared = prepareFilter(filter);
  if (!prepared) return resources;
  const key = filterKeyOf(filter);
  return resources.filter((resource) => {
    const cached = filterHits.get(resource);
    if (cached && cached.key === key) return cached.matched;
    const matched = matchesPrepared(resource, prepared);
    filterHits.set(resource, { key, matched });
    return matched;
  });
};

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Letter or digit; ASCII is decided without the Unicode RegExp (hot path of every keystroke). */
const isWordChar = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  if (Number.isNaN(code)) return false;
  if (code < 128) {
    return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  }
  // A character outside the basic plane is two units; either half stands for the whole of it.
  if (code >= 0xdc00 && code <= 0xdfff) {
    const high = text.charCodeAt(index - 1);
    return high >= 0xd800 && high <= 0xdbff && WORD_CHAR.test(text.slice(index - 1, index + 1));
  }
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(index) ?? code));
};

/**
 * How `token` occurs in `text`: 0 = not at all, 1 = inside a word, 2 = at the start of a word,
 * 3 = as a whole word ("1999" is whole in "page 1999" but only a prefix of "page 19999").
 */
const tokenMatchKind = (text: string, token: string, enough: 2 | 3 = 3): 0 | 1 | 2 | 3 => {
  let index = text.indexOf(token);
  if (index < 0) return 0;
  let best: 0 | 1 | 2 | 3 = 1;
  while (index >= 0) {
    if (index === 0 || !isWordChar(text, index - 1)) {
      if (!isWordChar(text, index + token.length)) return 3;
      if (enough === 2) return 2;
      best = 2;
    }
    index = text.indexOf(token, index + 1);
  }
  return best;
};

/** Title tokens joined by one space: the key an exact title query is compared against. */
const titleKeyCache = new WeakMap<Resource, string>();
const titleKeyOf = (resource: Resource): string => {
  let key = titleKeyCache.get(resource);
  if (key === undefined) {
    key = tokenize(resource.title).join(' ');
    titleKeyCache.set(resource, key);
  }
  return key;
};

const EXACT_TITLE_BONUS = 10;

/** Score of one query token against one record (0 = absent; at most 11, fits a byte). */
const tokenScore = (fields: SearchFields, token: string): number => {
  if (!fields.all.includes(token)) return 0;
  let score = 1;
  const inTitle = tokenMatchKind(fields.title, token);
  if (inTitle === 3) score += 5;
  else if (inTitle === 2) score += 4;
  else if (inTitle === 1) score += 2;
  if (fields.tags.includes(token)) score += 2;
  if (fields.host.includes(token)) score += 2;
  if (tokenMatchKind(fields.all, token, 2) >= 2) score += 1;
  return score;
};

/** Combines per-token scores; the same formula for the single-record and the indexed path. */
const combineScore = (
  sum: number,
  matched: number,
  tokenCount: number,
  exactTitle: boolean,
  isFavorite: boolean,
): number => {
  if (matched === 0) return 0;
  const score = exactTitle ? sum + EXACT_TITLE_BONUS : sum;
  // Prefer records that match more of the question.
  return score * (matched / tokenCount) + (isFavorite ? 0.5 : 0);
};

/**
 * Search index per library array (WeakMap-keyed, so it drops when the array does). Per-token
 * score columns are cached LRU so a query reuses prior tokens' columns and scores only the new one.
 */
interface LibraryIndex {
  fields: SearchFields[];
  titleKeys: (string | undefined)[];
  tokens: Map<string, Uint8Array>;
}

const MAX_TOKEN_COLUMNS = 32;
const libraryIndexCache = new WeakMap<readonly Resource[], LibraryIndex>();

const libraryIndex = (resources: readonly Resource[]): LibraryIndex => {
  let index = libraryIndexCache.get(resources);
  if (!index) {
    index = { fields: resources.map(searchFields), titleKeys: [], tokens: new Map() };
    libraryIndexCache.set(resources, index);
  }
  return index;
};

const tokenColumn = (index: LibraryIndex, token: string): Uint8Array => {
  const cached = index.tokens.get(token);
  if (cached) {
    index.tokens.delete(token);
    index.tokens.set(token, cached);
    return cached;
  }
  const column = new Uint8Array(index.fields.length);
  for (let i = 0; i < column.length; i += 1) {
    column[i] = tokenScore(index.fields[i] as SearchFields, token);
  }
  if (index.tokens.size >= MAX_TOKEN_COLUMNS) {
    const oldest = index.tokens.keys().next().value;
    if (oldest !== undefined) index.tokens.delete(oldest);
  }
  index.tokens.set(token, column);
  return column;
};

interface Ranked {
  resource: Resource;
  score: number;
}

/** Higher score first, then newer; equal entries keep their input order. */
const outranks = (score: number, resource: Resource, other: Ranked) =>
  score > other.score || (score === other.score && resource.createdAt > other.resource.createdAt);

/**
 * Top-N most relevant resources for a free-text query (stop-words are naturally low-weight).
 * Ties go to the newer record, then to the input order.
 */
export const rankResources = (resources: Resource[], query: string, limit: number): Resource[] => {
  const tokens = [...new Set(tokenize(query).filter((token) => token.length > 1))];
  if (tokens.length === 0 || limit <= 0) return [];
  const queryKey = tokenize(query).join(' ');
  const index = libraryIndex(resources);
  const columns = tokens.map((token) => tokenColumn(index, token));
  // One pass keeping the best `limit` entries sorted; no sort over every match.
  const best: Ranked[] = [];
  for (let i = 0; i < resources.length; i += 1) {
    let sum = 0;
    let matched = 0;
    for (const column of columns) {
      const value = column[i] as number;
      if (value === 0) continue;
      sum += value;
      matched += 1;
    }
    if (matched === 0) continue;
    const resource = resources[i] as Resource;
    let exact = false;
    if (matched === tokens.length) {
      let key = index.titleKeys[i];
      if (key === undefined) {
        key = titleKeyOf(resource);
        index.titleKeys[i] = key;
      }
      exact = key === queryKey;
    }
    const score = combineScore(sum, matched, tokens.length, exact, resource.isFavorite);
    if (best.length === limit && !outranks(score, resource, best[limit - 1] as Ranked)) continue;
    let at = best.length;
    while (at > 0 && outranks(score, resource, best[at - 1] as Ranked)) at -= 1;
    best.splice(at, 0, { resource, score });
    if (best.length > limit) best.pop();
  }
  return best.map((entry) => entry.resource);
};

export const sortByCreatedAt = (resources: Resource[], direction: 'asc' | 'desc' = 'desc') =>
  [...resources].sort((a, b) =>
    direction === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
  );

/** What the feed shows: records with an AI summary, newest first. */
export const feedResources = (resources: Resource[]): Resource[] =>
  sortByCreatedAt(resources.filter((r) => r.summary.length > 0));

/** Hard cap on rendered graph nodes; the newest resources are shown. */
export const MAX_GRAPH_NODES = 400;

export const graphResources = (resources: Resource[]): Resource[] =>
  resources.length > MAX_GRAPH_NODES
    ? sortByCreatedAt(resources).slice(0, MAX_GRAPH_NODES)
    : resources;

export interface HealthSummary {
  total: number;
  broken: number;
  protected: number;
  missingPreview: number;
  healthy: number;
  unchecked: number;
  notAnalyzed: number;
}

export const isProtectedResource = (resource: Resource): boolean =>
  resource.health.status === 'protected' ||
  Boolean(resource.media.challenge) ||
  Boolean(resource.media.previewBlocked);

export type HealthClass = 'broken' | 'protected' | 'missingPreview' | 'healthy';

/** The one bucket a record falls in on the health page; the summary counts the same buckets. */
export const classifyHealth = (resource: Resource): HealthClass => {
  if (resource.health.status === 'dead') return 'broken';
  if (isProtectedResource(resource)) return 'protected';
  return hasPreview(resource) ? 'healthy' : 'missingPreview';
};

export const needsPreview = (resource: Resource): boolean =>
  classifyHealth(resource) === 'missingPreview';

export const needsAnalysis = (resource: Resource): boolean =>
  resource.ai.status === 'none' || resource.ai.status === 'failed';

export const LOW_CONFIDENCE_THRESHOLD = 0.4;

export const isLowConfidence = (resource: Resource): boolean =>
  resource.ai.confidence !== null && resource.ai.confidence < LOW_CONFIDENCE_THRESHOLD;

export const healthSummary = (resources: Resource[]): HealthSummary => {
  const summary: HealthSummary = {
    total: resources.length,
    broken: 0,
    protected: 0,
    missingPreview: 0,
    healthy: 0,
    unchecked: 0,
    notAnalyzed: 0,
  };
  for (const resource of resources) {
    if (needsAnalysis(resource)) summary.notAnalyzed += 1;
    if (resource.health.status === 'unknown') summary.unchecked += 1;
    summary[classifyHealth(resource)] += 1;
  }
  return summary;
};

/** Whole percent of working links; never 100 with a broken link, never 0 with a working one. */
export const workingPercent = (checked: number, broken: number): number => {
  if (checked <= 0) return 100;
  const working = checked - broken;
  if (working <= 0) return 0;
  if (broken <= 0) return 100;
  return Math.min(99, Math.max(1, Math.round((working / checked) * 100)));
};

export const categoryDistribution = (
  resources: Resource[],
): { id: CategoryId; count: number }[] => {
  const counts = new Map<CategoryId, number>();
  for (const resource of resources) {
    counts.set(resource.categoryId, (counts.get(resource.categoryId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);
};

/** The batch action dock covers the bottom of the workspace while records are selected. */
export const isDockVisible = (state: { batchSelectedIds: string[] }): boolean =>
  state.batchSelectedIds.length > 0;

const byIdCache = new WeakMap<readonly Resource[], Map<string, Resource>>();

/** Record by id, through an index memoized on the array (rebuilt once per library write). */
export const resourceById = (
  resources: readonly Resource[],
  id: string | null,
): Resource | undefined => {
  if (id === null) return undefined;
  let index = byIdCache.get(resources);
  if (!index) {
    index = new Map(resources.map((resource) => [resource.id, resource]));
    byIdCache.set(resources, index);
  }
  return index.get(id);
};

const idSetCache = new WeakMap<readonly string[], Set<string>>();

/** Set view of an id list, memoized on the array so every mounted card shares one lookup. */
export const selectedIdSet = (ids: readonly string[]): Set<string> => {
  let set = idSetCache.get(ids);
  if (!set) {
    set = new Set(ids);
    idSetCache.set(ids, set);
  }
  return set;
};

interface ScopeState {
  resources: Resource[];
  collections: Collection[];
  scope: Scope;
  searchQuery: string;
}

export const activeCollectionOf = (state: Pick<ScopeState, 'collections' | 'scope'>) => {
  const id = scopeCollectionId(state.scope);
  return id ? (state.collections.find((c) => c.id === id) ?? null) : null;
};

/** Resources visible in the current library scope (all / favorites / collection) and search. */
export const visibleResources = (state: ScopeState, query = state.searchQuery): Resource[] =>
  filterResources(state.resources, {
    query,
    collection: activeCollectionOf(state),
    favoritesOnly: state.scope === 'favorites',
  });

/** The records the active library view renders: the feed skips unanalyzed ones, the graph caps. */
export const viewResources = (state: ScopeState & { viewMode: ViewMode }): Resource[] => {
  const visible = visibleResources(state);
  if (state.viewMode === 'feed') return feedResources(visible);
  if (state.viewMode === 'graph') return graphResources(visible);
  return visible;
};
