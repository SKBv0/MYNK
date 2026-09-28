/** The persisted library format (version 3): parsing, validation and normalization. */
import type {
  ChatMessage,
  Collection,
  HealthMeta,
  Language,
  Resource,
  ThemeConfig,
} from '../types';
import { GLOBAL_CHAT_KEY } from '../types';
import { IpcError } from '../services/ipc';
import { isLanguage } from '../translations';
import {
  copyChats,
  dedupeResources,
  mergeChatLists,
  normalizeChatMessage,
  normalizeCollection,
  normalizeResource,
} from './model';
import { DEFAULT_THEME } from './slices/ui';
import { isThemeMode, type ThemeMode } from '../lib/theme';
import { parseHex } from '../lib/color';
import { isViewMode, type ViewMode } from '../lib/nav';

export const PERSIST_VERSION = 3;
export const LIBRARY_STORAGE_KEY = 'mynk.library.v3';
export const BACKUP_KEY_PREFIX = 'mynk.backup.';

export interface PersistedSettings {
  lang: Language;
  theme: ThemeConfig;
  themeMode: ThemeMode;
  viewMode: ViewMode;
  isSidebarCollapsed: boolean;
}

export interface PersistedLibrary {
  version: typeof PERSIST_VERSION;
  savedAt: number;
  resources: Resource[];
  collections: Collection[];
  chats: Record<string, ChatMessage[]>;
  settings: PersistedSettings;
  healthMeta: HealthMeta;
}

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Only a hex accent is kept; obsolete `bg` / `accentRGB` fields are dropped (same version). */
const sanitizeTheme = (raw: unknown): ThemeConfig => {
  if (!isRecord(raw)) return DEFAULT_THEME;
  return typeof raw.accent === 'string' && parseHex(raw.accent)
    ? { accent: raw.accent }
    : DEFAULT_THEME;
};

const sanitizeSettings = (raw: unknown): PersistedSettings => {
  const s = isRecord(raw) ? raw : {};
  return {
    lang: isLanguage(s.lang) ? s.lang : 'en',
    theme: sanitizeTheme(s.theme),
    themeMode: isThemeMode(s.themeMode) ? s.themeMode : 'dark',
    viewMode: isViewMode(s.viewMode) ? s.viewMode : 'grid',
    isSidebarCollapsed: s.isSidebarCollapsed === true,
  };
};

const sanitizeHealthMeta = (raw: unknown): HealthMeta => {
  const h = isRecord(raw) ? raw : {};
  return {
    hasRun: h.hasRun === true,
    lastScanAt: typeof h.lastScanAt === 'number' ? h.lastScanAt : null,
  };
};

const mergeChats = (
  chats: Record<string, ChatMessage[]>,
  key: string,
  messages: ChatMessage[],
): void => {
  if (messages.length === 0) return;
  // Merged by message id, so two threads that share messages don't duplicate them.
  chats[key] = mergeChatLists(chats[key] ?? [], messages);
};

/** Re-points references after dedup and drops dangling ones. */
export const finalizeReferences = (
  resources: Resource[],
  collections: Collection[],
  chats: Record<string, ChatMessage[]>,
  remap: Map<string, string>,
): { collections: Collection[]; chats: Record<string, ChatMessage[]> } => {
  const ids = new Set(resources.map((r) => r.id));
  const fixedCollections = collections.map((c) => ({
    ...c,
    pinnedIds: [...new Set(c.pinnedIds.map((id) => remap.get(id) ?? id))].filter((id) =>
      ids.has(id),
    ),
  }));
  const fixedChats = copyChats();
  for (const [key, messages] of Object.entries(chats)) {
    const target = key === GLOBAL_CHAT_KEY ? key : (remap.get(key) ?? key);
    if (target !== GLOBAL_CHAT_KEY && !ids.has(target)) continue;
    mergeChats(fixedChats, target, messages);
  }
  return { collections: fixedCollections, chats: fixedChats };
};

/** Validates and normalizes a v3 payload (rehydrate path). */
export const normalizePersisted = (raw: unknown, now = Date.now()): PersistedLibrary => {
  const p = isRecord(raw) ? raw : {};
  const normalized = asArray(p.resources)
    .map((r) => normalizeResource(r, now))
    .filter((r): r is Resource => r !== null);
  const { resources, remap } = dedupeResources(normalized);
  const collections = asArray(p.collections)
    .map((c) => normalizeCollection(c, now))
    .filter((c): c is Collection => c !== null);
  const chats = copyChats();
  if (isRecord(p.chats)) {
    for (const [key, list] of Object.entries(p.chats)) {
      chats[key] = asArray(list)
        .map((m) => normalizeChatMessage(m, now))
        .filter((m): m is ChatMessage => m !== null);
    }
  }
  const fixed = finalizeReferences(resources, collections, chats, remap);
  return {
    version: PERSIST_VERSION,
    savedAt: typeof p.savedAt === 'number' ? p.savedAt : now,
    resources,
    collections: fixed.collections,
    chats: fixed.chats,
    settings: sanitizeSettings(p.settings),
    healthMeta: sanitizeHealthMeta(p.healthMeta),
  };
};

/**
 * Thrown when the stored library was written by a newer schema than this build knows.
 * `IpcError` + `detail`, so the toast is translated instead of showing the English text below.
 */
export class FutureVersionError extends IpcError {
  readonly version: number;

  constructor(version: number) {
    super(
      'storage',
      `Library was written by a newer version of MYNK (schema v${version}, this build understands v${PERSIST_VERSION}). Refusing to read or overwrite it.`,
    );
    this.name = 'FutureVersionError';
    this.version = version;
    this.withDetail({
      key: 'futureVersion',
      vars: { found: version, supported: PERSIST_VERSION },
    });
  }
}

/** Thrown when the stored library is not a readable v3 file. */
export class CorruptLibraryError extends IpcError {
  constructor(detail: string) {
    super('storage', `Library file ${detail}. Refusing to overwrite it.`);
    this.name = 'CorruptLibraryError';
    this.withDetail({ key: 'corruptLibrary' });
  }
}

/**
 * Parses the stored library. Throws for anything that is not a readable v3 file, so the caller
 * blocks writes to it.
 */
export const parsePersisted = (json: string, now = Date.now()): PersistedLibrary => {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new CorruptLibraryError('is not a JSON object');
  if (typeof parsed.version !== 'number') throw new CorruptLibraryError('has no version field');
  if (parsed.version > PERSIST_VERSION) throw new FutureVersionError(parsed.version);
  if (parsed.version !== PERSIST_VERSION) {
    throw new CorruptLibraryError(`has unsupported version ${parsed.version}`);
  }
  assertCurrentShape(parsed);
  return normalizePersisted(parsed, now);
};

/**
 * A v3 file whose sections have the wrong type would otherwise be emptied and then overwritten.
 * Missing sections are fine: not every v3 file writes all of them.
 */
const assertCurrentShape = (record: AnyRecord): void => {
  if (!Array.isArray(record.resources)) {
    throw new CorruptLibraryError('has no resource list');
  }
  const checks: Array<[keyof PersistedLibrary, (value: unknown) => boolean]> = [
    ['collections', Array.isArray],
    ['chats', isRecord],
    ['settings', isRecord],
    ['healthMeta', isRecord],
  ];
  for (const [key, isValid] of checks) {
    if (record[key] !== undefined && !isValid(record[key])) {
      throw new CorruptLibraryError(`has a damaged "${key}" section`);
    }
  }
};
