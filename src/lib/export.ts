/**
 * Library export/backup: pure functions; writing the file is left to the caller.
 * In the Netscape HTML output a comma inside a tag is written as `%2C` (and `%` as `%25`): a
 * round-trip contract with services/bookmarkParser.ts, so changing it corrupts tags silently.
 */
import type { ChatMessage, Collection, Resource } from '../types';
import { PERSIST_VERSION, normalizePersisted } from '../store/migrate';

export const BACKUP_APP_ID = 'mynk';

export interface LibraryBackup {
  app: typeof BACKUP_APP_ID;
  version: typeof PERSIST_VERSION;
  exportedAt: string;
  resources: Resource[];
  collections: Collection[];
  chats?: Record<string, ChatMessage[]>;
}

export interface BackupInput {
  resources: Resource[];
  collections: Collection[];
  chats?: Record<string, ChatMessage[]>;
}

const buildBackup = (input: BackupInput, now = new Date()): LibraryBackup => {
  const backup: LibraryBackup = {
    app: BACKUP_APP_ID,
    version: PERSIST_VERSION,
    exportedAt: now.toISOString(),
    resources: input.resources,
    collections: input.collections,
  };
  if (input.chats && Object.keys(input.chats).length > 0) backup.chats = input.chats;
  return backup;
};

export const backupToJson = (input: BackupInput, now = new Date()): string =>
  JSON.stringify(buildBackup(input, now), null, 2);

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Inverse of `decodeNetscapeTag` (services/bookmarkParser.ts): keeps TAGS splittable on commas. */
export const encodeNetscapeTag = (tag: string): string =>
  tag.replace(/%/g, '%25').replace(/,/g, '%2C');

const toSeconds = (ms: number | null | undefined): number =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;

interface FolderNode {
  name: string;
  folders: Map<string, FolderNode>;
  items: Resource[];
  addedAt: number;
  modifiedAt: number;
}

const newFolder = (name: string): FolderNode => ({
  name,
  folders: new Map(),
  items: [],
  addedAt: Number.POSITIVE_INFINITY,
  modifiedAt: 0,
});

const buildTree = (resources: Resource[]): FolderNode => {
  const root = newFolder('');
  for (const resource of resources) {
    let node = root;
    for (const raw of resource.folderPath) {
      const name = raw.trim();
      if (!name) continue;
      let child = node.folders.get(name);
      if (!child) {
        child = newFolder(name);
        node.folders.set(name, child);
      }
      child.addedAt = Math.min(child.addedAt, resource.createdAt);
      child.modifiedAt = Math.max(child.modifiedAt, resource.updatedAt);
      node = child;
    }
    node.items.push(resource);
  }
  return root;
};

const renderItem = (resource: Resource, indent: string): string[] => {
  const attrs = [
    `HREF="${escapeHtml(resource.url)}"`,
    `ADD_DATE="${toSeconds(resource.createdAt)}"`,
  ];
  const modified = toSeconds(resource.updatedAt);
  if (modified > 0) attrs.push(`LAST_MODIFIED="${modified}"`);
  if (resource.tags.length > 0) {
    attrs.push(`TAGS="${escapeHtml(resource.tags.map(encodeNetscapeTag).join(','))}"`);
  }
  const lines = [`${indent}<DT><A ${attrs.join(' ')}>${escapeHtml(resource.title)}</A>`];
  if (resource.description.trim()) {
    lines.push(`${indent}<DD>${escapeHtml(resource.description.trim().replace(/\s+/g, ' '))}`);
  }
  return lines;
};

const renderFolder = (node: FolderNode, depth: number): string[] => {
  const indent = '    '.repeat(depth);
  const lines: string[] = [];
  for (const child of node.folders.values()) {
    const added = Number.isFinite(child.addedAt) ? toSeconds(child.addedAt) : 0;
    lines.push(
      `${indent}<DT><H3 ADD_DATE="${added}" LAST_MODIFIED="${toSeconds(child.modifiedAt)}">${escapeHtml(child.name)}</H3>`,
      `${indent}<DL><p>`,
      ...renderFolder(child, depth + 1),
      `${indent}</DL><p>`,
    );
  }
  for (const item of node.items) lines.push(...renderItem(item, indent));
  return lines;
};

/** Netscape Bookmark File: the format every browser's bookmark importer reads. */
export const toNetscapeHtml = (resources: Resource[], title = 'MYNK'): string =>
  [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(title)}</TITLE>`,
    `<H1>${escapeHtml(title)}</H1>`,
    '<DL><p>',
    ...renderFolder(buildTree(resources), 1),
    '</DL><p>',
    '',
  ].join('\n');

/** `mynk-<yyyy-mm-dd>.<json|html>` */
export const exportFileName = (format: 'json' | 'html', now = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `mynk-${stamp}.${format === 'json' ? 'json' : 'html'}`;
};

export type BackupParseError =
  'invalidJson' | 'notMynk' | 'unsupportedVersion' | 'oldVersion' | 'invalidVersion';

export class BackupError extends Error {
  code: BackupParseError;
  constructor(code: BackupParseError) {
    super(code);
    this.name = 'BackupError';
    this.code = code;
  }
}

export interface ParsedBackup {
  exportedAt: string | null;
  resources: Resource[];
  collections: Collection[];
  chats: Record<string, ChatMessage[]>;
}

/**
 * Validates a JSON backup and normalizes it with the same helpers the library file uses; only
 * the current schema is read, and a missing or malformed version is rejected.
 */
export const parseBackup = (json: string, now = Date.now()): ParsedBackup => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new BackupError('invalidJson');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BackupError('notMynk');
  }
  const record = raw as Record<string, unknown>;
  if (record.app !== BACKUP_APP_ID || !Array.isArray(record.resources)) {
    throw new BackupError('notMynk');
  }
  const { version } = record;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new BackupError('invalidVersion');
  }
  if (version > PERSIST_VERSION) {
    throw new BackupError('unsupportedVersion');
  }
  if (version < PERSIST_VERSION) {
    throw new BackupError('oldVersion');
  }
  const data = normalizePersisted(
    { resources: record.resources, collections: record.collections, chats: record.chats },
    now,
  );
  return {
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : null,
    resources: data.resources,
    collections: data.collections,
    chats: data.chats,
  };
};
