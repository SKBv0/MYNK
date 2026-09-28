/** Information architecture: `scope` × `viewMode` for the library, plus a few separate pages. */
import type { TranslationSchema } from '../translations';

export type Page = 'library' | 'collections' | 'health' | 'settings';
export type ViewMode = 'grid' | 'graph' | 'timeline' | 'feed';
export type Scope = 'all' | 'favorites' | { collectionId: string };

export const PAGES: readonly Page[] = ['library', 'collections', 'health', 'settings'];
export const VIEW_MODES: readonly ViewMode[] = ['grid', 'graph', 'timeline', 'feed'];

export const isViewMode = (value: unknown): value is ViewMode =>
  typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);

export const scopeCollectionId = (scope: Scope): string | null =>
  typeof scope === 'object' ? scope.collectionId : null;

export const sameScope = (a: Scope, b: Scope): boolean =>
  typeof a === 'object' && typeof b === 'object' ? a.collectionId === b.collectionId : a === b;

export const pageLabel = (page: Page, t: TranslationSchema): string => t.nav.pages[page];
export const viewLabel = (mode: ViewMode, t: TranslationSchema): string => t.nav.views[mode];

/** Display name of the current library scope; `null` for the whole library. */
export const scopeName = (
  scope: Scope,
  collection: { name: string } | null,
  t: TranslationSchema,
): string | null => (scope === 'favorites' ? t.nav.favorites : (collection?.name ?? null));

/** Title used by the title bar / document title. */
export const locationTitle = (
  page: Page,
  viewMode: ViewMode,
  scopeName: string | null,
  t: TranslationSchema,
): string =>
  page === 'library'
    ? `${scopeName ?? t.nav.pages.library} · ${viewLabel(viewMode, t)}`
    : pageLabel(page, t);
