import { CATEGORY_IDS, type CategoryId } from '../services/ipcTypes';
import { normalizeSearchText } from './text';

export { CATEGORY_IDS };
export type { CategoryId };

const CATEGORY_SET = new Set<string>(CATEGORY_IDS);

export const isCategoryId = (value: unknown): value is CategoryId =>
  typeof value === 'string' && CATEGORY_SET.has(value);

/** Normalized browser root-folder names, which the bookmark import does not turn into tags. */
export const ROOT_FOLDER_NAMES: ReadonlySet<string> = new Set(
  [
    'bookmarks',
    'bookmarks bar',
    'bookmarks toolbar',
    'bookmarks menu',
    'other bookmarks',
    'mobile bookmarks',
    'synced',
    'favorites bar',
    'favourites bar',
    'yer imleri',
    'yer imleri çubuğu',
    'diğer yer imleri',
    'mobil yer imleri',
    'yer işaretleri araç çubuğu',
    'yer işaretleri menüsü',
    'favoriler çubuğu',
  ].map(normalizeSearchText),
);
