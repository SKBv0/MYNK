/**
 * Pure constructors / normalizers for the domain model. Used by the store slices, the
 * library loader and the importers so every Resource has the same shape.
 */
import type { AnalyzeResult } from '../services/ipcTypes';
import type {
  AiStatus,
  ChatMessage,
  ChatMessageUsage,
  Collection,
  HealthFailureKind,
  HealthStatus,
  Resource,
  ResourceAi,
  ResourceHealth,
  ResourceMedia,
} from '../types';
import { newId } from '../lib/id';
import {
  canonicalUrlKey,
  hostOf,
  isHttpUrl,
  looksLikeUrl,
  normalizeInputUrl,
  type NormalizeUrlOptions,
} from '../lib/url';
import { isCategoryId } from '../lib/categories';
import { isSafeFileName } from '../lib/files';
import { WEBKIT_EPOCH_OFFSET_MS } from '../lib/time';
import { normalizeTags } from '../lib/text';

export const MAX_CHAT_MESSAGES = 100;
export const MAX_SUMMARY_LINES = 8;

const DAY_MS = 86_400_000;
/** Dates before this are treated as garbage (no bookmark in the library predates 1990). */
export const MIN_PLAUSIBLE_TIMESTAMP = Date.UTC(1990, 0, 1);
/** How far in the future a stored date may be (clock skew between machines) before it is fixed. */
export const MAX_FUTURE_MS = 365 * DAY_MS;

/** True for an epoch-ms date between 1990 and one year from `now`. */
export const isPlausibleTimestamp = (value: unknown, now = Date.now()): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= MIN_PLAUSIBLE_TIMESTAMP &&
  value <= now + MAX_FUTURE_MS;

/**
 * Repairs a stored date: a Chrome import that divided WebKit microseconds by 1000 without the
 * 1601 offset (~year 2390) is shifted back; anything else implausible becomes `now`.
 */
export const fixTimestamp = (value: unknown, now: number): { value: number; fixed: boolean } => {
  if (isPlausibleTimestamp(value, now)) return { value, fixed: false };
  if (typeof value === 'number' && Number.isFinite(value)) {
    const shifted = value - WEBKIT_EPOCH_OFFSET_MS;
    if (isPlausibleTimestamp(shifted, now)) return { value: shifted, fixed: true };
  }
  return { value: now, fixed: value !== undefined };
};

const AI_STATUSES: readonly AiStatus[] = ['none', 'pending', 'ok', 'insufficient', 'failed'];
const HEALTH_STATUSES: readonly HealthStatus[] = ['unknown', 'alive', 'protected', 'dead'];
const HEALTH_FAILURE_KINDS: readonly HealthFailureKind[] = [
  'dns',
  'timeout',
  'tls',
  'refused',
  'http',
  'blocked',
  'other',
];

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Remote media URLs are accepted over http/https only. */
export const isAllowedRemoteMedia = (value: unknown): value is string =>
  typeof value === 'string' && isHttpUrl(value);

export const cleanSummary = (lines: unknown): string[] =>
  asStringList(lines)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_LINES);

const normalizeMedia = (raw: unknown): ResourceMedia => {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const media: ResourceMedia = {};
  if (isAllowedRemoteMedia(m.faviconUrl)) media.faviconUrl = m.faviconUrl;
  if (isAllowedRemoteMedia(m.imageUrl)) media.imageUrl = m.imageUrl;
  if (isSafeFileName(m.snapshotFile)) media.snapshotFile = m.snapshotFile;
  if (isSafeFileName(m.uploadedFile)) media.uploadedFile = m.uploadedFile;
  if (isSafeFileName(m.faviconFile)) media.faviconFile = m.faviconFile;
  if (isSafeFileName(m.imageFile)) media.imageFile = m.imageFile;
  if (typeof m.remoteCachedAt === 'number' && Number.isFinite(m.remoteCachedAt)) {
    media.remoteCachedAt = m.remoteCachedAt;
  }
  if (m.previewBlocked === true) media.previewBlocked = true;
  if (m.challenge === true) media.challenge = true;
  return media;
};

const normalizeAi = (raw: unknown): ResourceAi => {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let status = AI_STATUSES.includes(a.status as AiStatus) ? (a.status as AiStatus) : 'none';
  // A persisted "pending" means the app was closed mid-analysis: it never finished.
  if (status === 'pending') status = 'none';
  const confidence = asNumberOrNull(a.confidence);
  const ai: ResourceAi = {
    status,
    analyzedAt: asNumberOrNull(a.analyzedAt),
    confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)),
  };
  if (typeof a.error === 'string' && a.error) ai.error = a.error.slice(0, 300);
  return ai;
};

const normalizeHealth = (raw: unknown): ResourceHealth => {
  const h = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const health: ResourceHealth = {
    status: HEALTH_STATUSES.includes(h.status as HealthStatus)
      ? (h.status as HealthStatus)
      : 'unknown',
    checkedAt: asNumberOrNull(h.checkedAt),
  };
  const httpStatus = asNumberOrNull(h.httpStatus);
  if (httpStatus !== null) health.httpStatus = httpStatus;
  if (HEALTH_FAILURE_KINDS.includes(h.errorKind as HealthFailureKind)) {
    health.errorKind = h.errorKind as HealthFailureKind;
  }
  return health;
};

export interface ResourceInit {
  url: string;
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  folderPath?: string[] | undefined;
  createdAt?: number | undefined;
  /** Last modification from an import (Netscape `LAST_MODIFIED`); defaults to `now`. */
  updatedAt?: number | undefined;
  ai?: Partial<ResourceAi> | undefined;
}

/**
 * Builds a new Resource; `null` when the URL is not a valid http(s) URL. `options.allowDotlessHost`
 * accepts intranet hosts (e.g. `http://wiki/`) for importers; typed input keeps the strict check.
 */
export const createResource = (
  init: ResourceInit,
  now = Date.now(),
  options: NormalizeUrlOptions = {},
): Resource | null => {
  const url = normalizeInputUrl(init.url, options);
  if (!url) return null;
  const createdAt = isPlausibleTimestamp(init.createdAt, now) ? Math.min(init.createdAt, now) : now;
  const updatedAt = isPlausibleTimestamp(init.updatedAt, now)
    ? Math.min(Math.max(init.updatedAt, createdAt), now)
    : now;
  return {
    id: newId(),
    url,
    urlKey: canonicalUrlKey(url),
    title: (init.title ?? '').trim() || hostOf(url),
    description: (init.description ?? '').trim(),
    categoryId: 'other',
    tags: normalizeTags(init.tags ?? []),
    summary: [],
    folderPath: (init.folderPath ?? []).map((p) => p.trim()).filter(Boolean),
    createdAt,
    updatedAt,
    lastOpenedAt: null,
    isFavorite: false,
    ai: { status: 'none', analyzedAt: null, confidence: null, ...init.ai },
    media: {},
    health: { status: 'unknown', checkedAt: null },
  };
};

/**
 * Validates an arbitrary (persisted) object into a Resource, `null` without a usable URL;
 * `urlKey` is recomputed on every load, so changing the normalization needs no migration.
 */
export const normalizeResource = (raw: unknown, now = Date.now()): Resource | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Stored URLs always carry their scheme, so imported intranet hosts survive a reload.
  const url = normalizeInputUrl(asString(r.url), { allowDotlessHost: true });
  if (!url) return null;
  const createdAt = fixTimestamp(r.createdAt, now).value;
  const resource: Resource = {
    id: asString(r.id) || newId(),
    url,
    urlKey: canonicalUrlKey(url),
    title: asString(r.title).trim() || hostOf(url),
    description: asString(r.description),
    categoryId: isCategoryId(r.categoryId) ? r.categoryId : 'other',
    tags: normalizeTags(asStringList(r.tags)),
    summary: cleanSummary(r.summary),
    folderPath: asStringList(r.folderPath),
    createdAt,
    updatedAt: isPlausibleTimestamp(r.updatedAt, now) ? r.updatedAt : createdAt,
    lastOpenedAt: isPlausibleTimestamp(r.lastOpenedAt, now) ? r.lastOpenedAt : null,
    isFavorite: r.isFavorite === true,
    ai: normalizeAi(r.ai),
    media: normalizeMedia(r.media),
    health: normalizeHealth(r.health),
  };
  if (r.titleEditedByUser === true) resource.titleEditedByUser = true;
  if (r.descriptionByAi === true) resource.descriptionByAi = true;
  if (r.tagsEditedByUser === true) resource.tagsEditedByUser = true;
  if (r.summaryEditedByUser === true) resource.summaryEditedByUser = true;
  return resource;
};

const AI_RANK: Record<AiStatus, number> = {
  ok: 4,
  insufficient: 3,
  failed: 2,
  pending: 1,
  none: 0,
};

const unionList = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

const laterOf = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
};

/**
 * Merges a duplicate (same urlKey) into `keep`: favorite/tags/summary are unioned, the oldest
 * createdAt wins, and the best AI result and richer media are kept.
 */
const mergeResources = (keep: Resource, dup: Resource): Resource => {
  const bestAi = AI_RANK[dup.ai.status] > AI_RANK[keep.ai.status] ? dup : keep;
  const other = bestAi === keep ? dup : keep;
  const keepTitleIsWeak = !keep.titleEditedByUser && looksLikeUrl(keep.title, keep.url);
  const title = keepTitleIsWeak && !looksLikeUrl(dup.title, dup.url) ? dup.title : keep.title;
  const merged: Resource = {
    ...keep,
    title,
    description:
      keep.description.length >= dup.description.length ? keep.description : dup.description,
    categoryId: bestAi.categoryId !== 'other' ? bestAi.categoryId : other.categoryId,
    tags: normalizeTags(unionList(keep.tags, dup.tags)),
    summary: unionList(bestAi.summary, other.summary).slice(0, MAX_SUMMARY_LINES),
    folderPath: keep.folderPath.length > 0 ? keep.folderPath : dup.folderPath,
    createdAt: Math.min(keep.createdAt, dup.createdAt),
    updatedAt: Math.max(keep.updatedAt, dup.updatedAt),
    lastOpenedAt: laterOf(keep.lastOpenedAt, dup.lastOpenedAt),
    isFavorite: keep.isFavorite || dup.isFavorite,
    ai: bestAi.ai,
    media: { ...dup.media, ...keep.media },
    health: (keep.health.checkedAt ?? 0) >= (dup.health.checkedAt ?? 0) ? keep.health : dup.health,
  };
  if (keep.titleEditedByUser || dup.titleEditedByUser) merged.titleEditedByUser = true;
  if (keep.tagsEditedByUser || dup.tagsEditedByUser) merged.tagsEditedByUser = true;
  if (keep.summaryEditedByUser || dup.summaryEditedByUser) merged.summaryEditedByUser = true;
  const descriptionOwner = merged.description === keep.description ? keep : dup;
  if (descriptionOwner.descriptionByAi) merged.descriptionByAi = true;
  else delete merged.descriptionByAi;
  return merged;
};

export interface DedupeOptions {
  /** Ids whose identity and media file names win when merged with a record outside the set. */
  primaryIds?: ReadonlySet<string>;
}

/**
 * De-duplicates by urlKey; the oldest createdAt survives unless `options.primaryIds` says
 * otherwise. Returns the list plus an id remap (removed → surviving) for stale references.
 */
export const dedupeResources = (
  list: Resource[],
  options: DedupeOptions = {},
): { resources: Resource[]; remap: Map<string, string> } => {
  const { primaryIds } = options;
  const byKey = new Map<string, Resource>();
  const order: string[] = [];
  const remap = new Map<string, string>();
  const seenIds = new Set<string>();

  for (const original of list) {
    let resource = original;
    if (seenIds.has(resource.id)) resource = { ...resource, id: newId() };
    seenIds.add(resource.id);

    const existing = byKey.get(resource.urlKey);
    if (!existing) {
      byKey.set(resource.urlKey, resource);
      order.push(resource.urlKey);
      continue;
    }
    const [older, newer] =
      existing.createdAt <= resource.createdAt ? [existing, resource] : [resource, existing];
    let merged = mergeResources(older, newer);
    let [keep, dup] = [older, newer];
    if (primaryIds && primaryIds.has(newer.id) && !primaryIds.has(older.id)) {
      [keep, dup] = [newer, older];
      // Only the primary record's file names exist on disk; the other copy gives URLs and flags.
      const {
        snapshotFile: _snapshotFile,
        uploadedFile: _uploadedFile,
        faviconFile: _faviconFile,
        imageFile: _imageFile,
        ...olderRemote
      } = older.media;
      merged = { ...merged, id: newer.id, media: { ...olderRemote, ...newer.media } };
    }
    byKey.set(resource.urlKey, merged);
    remap.set(dup.id, keep.id);
    // Ids already remapped onto `dup` have to follow it to `keep`.
    for (const [from, to] of remap) if (to === dup.id) remap.set(from, keep.id);
  }

  return { resources: order.map((key) => byKey.get(key) as Resource), remap };
};

/**
 * `baseUpdatedAt` is the record's `updatedAt` when the analysis started; a different one means
 * the user edited meanwhile, so only empty fields get filled. Only an AI-written description is
 * ever rewritten.
 */
export const applyAnalysisToResource = (
  resource: Resource,
  result: AnalyzeResult,
  now = Date.now(),
  baseUpdatedAt: number = resource.updatedAt,
): Resource => {
  const editedMeanwhile = resource.updatedAt !== baseUpdatedAt;
  const newTitle = result.title?.trim();
  // An insufficient result's title is a weak fallback: it may replace a URL-like title only.
  const canReplaceTitle = result.insufficientContent
    ? looksLikeUrl(resource.title, resource.url)
    : looksLikeUrl(resource.title, resource.url) || !resource.titleEditedByUser;
  const media: ResourceMedia = { ...resource.media };
  if (isAllowedRemoteMedia(result.faviconUrl)) media.faviconUrl = result.faviconUrl;
  if (isAllowedRemoteMedia(result.imageUrl)) media.imageUrl = result.imageUrl;
  const summary = cleanSummary(result.summary);
  const newDescription = result.description?.trim() ?? '';
  // A description the record came with (an agent's note, an import) is never overwritten; the
  // AI's own text is, so a second analysis can correct the first.
  const aiWritesDescription =
    newDescription.length > 0 && (!resource.description || resource.descriptionByAi === true);

  const next: Resource = {
    ...resource,
    title: newTitle && canReplaceTitle ? newTitle.slice(0, 300) : resource.title,
    description: aiWritesDescription ? newDescription : resource.description,
    // `other` is what a failed or unsure analysis reports: it never replaces a real category.
    categoryId:
      !editedMeanwhile && isCategoryId(result.categoryId) && result.categoryId !== 'other'
        ? result.categoryId
        : resource.categoryId,
    // User tags come first so an AI tag can never push one out once `normalizeTags` caps the list.
    tags: resource.tagsEditedByUser
      ? resource.tags
      : normalizeTags([...resource.tags, ...(result.tags ?? [])]),
    summary:
      resource.summaryEditedByUser || (editedMeanwhile && resource.summary.length > 0)
        ? resource.summary
        : summary.length > 0
          ? summary
          : resource.summary,
    updatedAt: now,
    ai: {
      status: result.insufficientContent ? 'insufficient' : 'ok',
      analyzedAt: now,
      confidence: Number.isFinite(result.confidence)
        ? Math.min(1, Math.max(0, result.confidence))
        : null,
    },
    media,
  };
  if (aiWritesDescription) next.descriptionByAi = true;
  return next;
};

/** Most keywords a collection keeps. */
export const MAX_COLLECTION_KEYWORDS = 64;

export const normalizeCollection = (raw: unknown, now = Date.now()): Collection | null => {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const name = asString(c.name).trim();
  if (!name) return null;
  return {
    id: asString(c.id) || newId(),
    name,
    description: asString(c.description),
    keywords: normalizeTags(asStringList(c.keywords), MAX_COLLECTION_KEYWORDS),
    pinnedIds: [...new Set(asStringList(c.pinnedIds))],
    createdAt: asNumberOrNull(c.createdAt) ?? now,
    updatedAt: asNumberOrNull(c.updatedAt) ?? now,
  };
};

export const normalizeChatMessage = (raw: unknown, now = Date.now()): ChatMessage | null => {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const content = asString(m.content);
  if (!content) return null;
  const message: ChatMessage = {
    id: asString(m.id) || newId(),
    role: m.role,
    content,
    createdAt: asNumberOrNull(m.createdAt) ?? asNumberOrNull(m.timestamp) ?? now,
  };
  const sources = asStringList(m.sources);
  if (sources.length > 0) message.sources = sources;
  if (message.role === 'assistant') {
    if (m.partial === true) message.partial = true;
    const usage = normalizeChatUsage(m.usage);
    if (usage) message.usage = usage;
  }
  return message;
};

const normalizeChatUsage = (raw: unknown): ChatMessageUsage | null => {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const promptTokens = asNumberOrNull(u.promptTokens);
  const completionTokens = asNumberOrNull(u.completionTokens);
  if (promptTokens === null || completionTokens === null) return null;
  if (u.provider !== 'ollama' && u.provider !== 'openrouter') return null;
  const usage: ChatMessageUsage = { promptTokens, completionTokens, provider: u.provider };
  const costUsd = asNumberOrNull(u.costUsd);
  if (costUsd !== null && costUsd >= 0) usage.costUsd = costUsd;
  const model = asString(u.model);
  if (model) usage.model = model;
  return usage;
};

/**
 * Copy of a chat map (or a fresh one) with a null prototype: threads are keyed by resource id,
 * and an id like `constructor` or `__proto__` must stay an ordinary key.
 */
export const copyChats = (
  from: Record<string, ChatMessage[]> = {},
): Record<string, ChatMessage[]> =>
  Object.assign(Object.create(null), from) as Record<string, ChatMessage[]>;

export const trimChat = (messages: ChatMessage[]): ChatMessage[] =>
  messages.length > MAX_CHAT_MESSAGES ? messages.slice(-MAX_CHAT_MESSAGES) : messages;

/**
 * Union of two chat threads by message id (the first occurrence wins, so pass the preferred
 * thread first), sorted oldest first and capped at `MAX_CHAT_MESSAGES`.
 */
export const mergeChatLists = (a: ChatMessage[], b: ChatMessage[]): ChatMessage[] => {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...a, ...b]) if (!byId.has(message.id)) byId.set(message.id, message);
  return trimChat([...byId.values()].sort((x, y) => x.createdAt - y.createdAt));
};
