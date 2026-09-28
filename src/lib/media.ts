import { faviconSources, previewSources } from '../services/resourceMedia';
import { snapshotSrc } from '../services/snapshots';
import type { Resource } from '../types';

const noSnapshot = (): string => '';

/** Preview candidates; snapshot files are skipped until `mediaReady` (memoize on it too). */
export const resourcePreviews = (resource: Resource, mediaReady: boolean): string[] =>
  previewSources(resource, mediaReady ? snapshotSrc : noSnapshot);

/** Favicon candidates (cached file → letter avatar); same `mediaReady` contract as above. */
export const resourceFavicons = (resource: Resource, mediaReady: boolean): string[] =>
  faviconSources(resource, mediaReady ? snapshotSrc : noSnapshot);
