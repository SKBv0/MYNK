/**
 * Bookmark file importers → `ImportedBookmark[]`. Netscape HTML: walks the <DL>/<DT>/<H3> tree.
 * Chrome/Edge JSON: `roots` tree, WebKit microsecond dates. Each entry is validated independently.
 */
import type { ImportedBookmark } from './ipcTypes';
import { yieldToMain } from '../lib/scheduling';
import { WEBKIT_EPOCH_OFFSET_MS } from '../lib/time';
import { parseHttpUrl } from '../lib/url';

const CHUNK_SIZE = 500;
const DAY_MS = 86_400_000;

export { yieldToMain };

/** Why a chosen file cannot be imported; `code` picks the sentence under `data.importErrors`. */
export class BookmarkFileError extends Error {
  constructor(readonly code: 'notBookmarkFile') {
    super(code);
    this.name = 'BookmarkFileError';
  }
}

/** The model's own title limit; a bookmark file may carry a whole page of text in one title. */
export const MAX_IMPORT_TITLE_CHARS = 300;

/** Titles are untrusted text: newlines and runs of spaces collapse, and length is capped. */
const cleanTitle = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, MAX_IMPORT_TITLE_CHARS);

const plausibleDate = (ms: number, now = Date.now()): number | undefined =>
  Number.isFinite(ms) && ms > 0 && ms <= now + DAY_MS ? Math.round(ms) : undefined;

/** WebKit/Chrome `date_added` (µs since 1601-01-01) → epoch ms. */
export const webkitMicrosToMs = (value: unknown): number | undefined => {
  const micros =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(micros) || micros <= 0) return undefined;
  return plausibleDate(micros / 1000 - WEBKIT_EPOCH_OFFSET_MS);
};

/** Netscape `ADD_DATE` (seconds since epoch) → epoch ms. */
export const netscapeSecondsToMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? plausibleDate(seconds * 1000) : undefined;
};

/** Normalized http(s) URL, or null. A bookmark file always spells the scheme out. */
const safeHttpUrl = (value: unknown): string | null =>
  typeof value === 'string'
    ? (parseHttpUrl(value, { assumeHttps: false })?.toString() ?? null)
    : null;

interface RawEntry {
  href: string | null;
  title: string;
  addedAt?: number | undefined;
  updatedAt?: number | undefined;
  folderPath: string[];
  tags?: string[] | undefined;
  description?: string | undefined;
}

/** One tag of a Netscape `TAGS` list; MYNK's own export encodes a comma inside a tag as `%2C`. */
export const decodeNetscapeTag = (value: string): string =>
  value.replace(/%2C/gi, ',').replace(/%25/g, '%');

const parseTagsAttribute = (value: string | null): string[] | undefined => {
  if (!value) return undefined;
  const tags = value
    .split(',')
    .map((t) => decodeNetscapeTag(t).trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
};

const TEXT_NODE = 3;

/**
 * Text of the element itself, not its descendants: an unclosed <H3>/<DD> swallows the following
 * <DL> in HTML5, so `textContent` would include every nested title.
 */
const ownText = (element: Element): string => {
  const text =
    element.children.length === 0
      ? (element.textContent ?? '')
      : Array.from(element.childNodes)
          .filter((node) => node.nodeType === TEXT_NODE)
          .map((node) => node.textContent ?? '')
          .join(' ');
  return text.replace(/\s+/g, ' ').trim();
};

interface WalkResult {
  /** Folder name (H3) not matched with its <DL> yet; the caller gives it to the next sibling DL. */
  pendingFolder: string | null;
  /** The subtree's last link (a following <DD> describes it), `null`/`undefined` otherwise. */
  last: RawEntry | null | undefined;
  /** The subtree contained a <DL> (so a pending folder name has been used up). */
  sawList: boolean;
}

/**
 * Recursion limit for `walk`, in elements (~2 per bookmark folder). A file with tens of thousands
 * of nested <DL>s would otherwise overflow the stack; anything deeper than this is skipped.
 */
const MAX_WALK_DEPTH = 64;

const collectNetscapeEntries = (root: Element): RawEntry[] => {
  const entries: RawEntry[] = [];

  const walk = (node: Element, path: string[], depth: number): WalkResult => {
    if (depth > MAX_WALK_DEPTH) return { pendingFolder: null, last: null, sawList: false };
    let pendingFolder: string | null = null;
    let last: RawEntry | null | undefined;
    let sawList = false;
    const folderPath = () => (pendingFolder ? [...path, pendingFolder] : path);

    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toUpperCase();
      if (tag === 'A') {
        // Reads MYNK's own TAGS attribute so a re-imported backup keeps its tags.
        const entry: RawEntry = {
          href: child.getAttribute('href'),
          title: cleanTitle(child.textContent ?? ''),
          addedAt: netscapeSecondsToMs(child.getAttribute('add_date')),
          updatedAt: netscapeSecondsToMs(child.getAttribute('last_modified')),
          folderPath: path,
          tags: parseTagsAttribute(child.getAttribute('tags')),
        };
        entries.push(entry);
        last = entry;
      } else if (tag === 'DD') {
        // Belongs to the link right before it; after a folder heading it attaches to nothing.
        const text = ownText(child);
        if (last && last.description === undefined && text) last.description = text;
        // A folder's <DD> contains that folder's <DL>: keep walking with the folder name.
        const inner = walk(child, folderPath(), depth + 1);
        if (inner.sawList) {
          pendingFolder = null;
          sawList = true;
        }
        last = null;
      } else if (tag === 'H3') {
        const name = ownText(child) || null;
        // An unclosed <H3> swallows the rest of the file; the links inside are still bookmarks.
        const inner = walk(child, name ? [...path, name] : path, depth + 1);
        if (inner.sawList) {
          pendingFolder = null;
          sawList = true;
        } else {
          pendingFolder = name;
        }
        last = null;
      } else if (tag === 'DL') {
        walk(child, folderPath(), depth + 1);
        pendingFolder = null;
        last = null;
        sawList = true;
      } else {
        const inner = walk(child, path, depth + 1);
        if (inner.pendingFolder !== null) pendingFolder = inner.pendingFolder;
        if (inner.last !== undefined) last = inner.last;
        if (inner.sawList) sawList = true;
      }
    }
    return { pendingFolder, last, sawList };
  };

  walk(root, [], 0);
  return entries;
};

/** Parsed bookmarks plus the links left out for having no usable http(s) address. */
export interface ParsedBookmarks {
  bookmarks: ImportedBookmark[];
  skipped: number;
}

const toBookmarks = async (entries: RawEntry[]): Promise<ParsedBookmarks> => {
  const result: ImportedBookmark[] = [];
  let skipped = 0;
  for (const [i, entry] of entries.entries()) {
    if (i > 0 && i % CHUNK_SIZE === 0) await yieldToMain();
    try {
      const url = safeHttpUrl(entry.href);
      if (!url) {
        skipped += 1;
        continue;
      }
      const bookmark: ImportedBookmark = {
        url,
        title: entry.title,
        folderPath: entry.folderPath,
      };
      if (entry.addedAt !== undefined) bookmark.addedAt = entry.addedAt;
      if (entry.updatedAt !== undefined) bookmark.updatedAt = entry.updatedAt;
      if (entry.tags && entry.tags.length > 0) bookmark.tags = entry.tags;
      if (entry.description) bookmark.description = entry.description;
      result.push(bookmark);
    } catch (error) {
      skipped += 1;
      console.warn('[MYNK] skipped malformed bookmark entry', error);
    }
  }
  return { bookmarks: result, skipped };
};

const readNetscapeHtml = (html: string): Promise<ParsedBookmarks> => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return toBookmarks(collectNetscapeEntries(doc.body ?? doc.documentElement));
};

export const parseNetscapeHtml = async (html: string): Promise<ImportedBookmark[]> =>
  (await readNetscapeHtml(html)).bookmarks;

interface ChromeNode {
  type?: unknown;
  url?: unknown;
  name?: unknown;
  date_added?: unknown;
  children?: unknown;
}

const ROOT_LABELS: Record<string, string> = {
  bookmark_bar: 'Bookmarks bar',
  other: 'Other bookmarks',
  synced: 'Mobile bookmarks',
};

const readChromeJson = async (json: string): Promise<ParsedBookmarks> => {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new BookmarkFileError('notBookmarkFile');
  }
  const roots =
    data && typeof data === 'object' ? (data as { roots?: Record<string, unknown> }).roots : null;
  if (!roots || typeof roots !== 'object') {
    throw new BookmarkFileError('notBookmarkFile');
  }

  const entries: RawEntry[] = [];
  const stack: { node: ChromeNode; path: string[] }[] = [];
  // Stack is LIFO: push roots in reverse so bookmark_bar comes out first.
  for (const [key, node] of Object.entries(roots).reverse()) {
    if (!node || typeof node !== 'object') continue;
    const rootNode = node as ChromeNode;
    const name =
      typeof rootNode.name === 'string' && rootNode.name ? rootNode.name : ROOT_LABELS[key];
    stack.push({ node: { ...rootNode, name: name ?? key }, path: [] });
  }

  let visited = 0;
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: ChromeNode; path: string[] };
    visited += 1;
    if (visited % CHUNK_SIZE === 0) await yieldToMain();
    try {
      if (node.type === 'url') {
        entries.push({
          href: typeof node.url === 'string' ? node.url : null,
          title: typeof node.name === 'string' ? cleanTitle(node.name) : '',
          addedAt: webkitMicrosToMs(node.date_added),
          folderPath: path,
        });
        continue;
      }
      if (Array.isArray(node.children)) {
        const folderPath =
          typeof node.name === 'string' && node.name.trim() ? [...path, node.name.trim()] : path;
        // Push in reverse so the original order is preserved when popping.
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          const child: unknown = node.children[i];
          if (child && typeof child === 'object') {
            stack.push({ node: child, path: folderPath });
          }
        }
      }
    } catch (error) {
      console.warn('[MYNK] skipped malformed bookmark node', error);
    }
  }

  return toBookmarks(entries);
};

export const parseChromeJson = async (json: string): Promise<ImportedBookmark[]> =>
  (await readChromeJson(json)).bookmarks;

export type BookmarkFileKind = 'html' | 'json';

export const detectBookmarkFileKind = (fileName: string, content: string): BookmarkFileKind => {
  if (/\.json$/i.test(fileName)) return 'json';
  if (/\.html?$/i.test(fileName)) return 'html';
  return content.trimStart().startsWith('{') ? 'json' : 'html';
};

/** Parses a user-selected bookmark export (HTML or Chromium JSON). */
export const parseBookmarkFile = async (file: {
  name: string;
  text: () => Promise<string>;
}): Promise<ParsedBookmarks> => {
  const content = await file.text();
  return detectBookmarkFileKind(file.name, content) === 'json'
    ? readChromeJson(content)
    : readNetscapeHtml(content);
};
