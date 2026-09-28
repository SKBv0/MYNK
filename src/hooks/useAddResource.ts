import { useCallback } from 'react';
import { getT, useAppStore } from '../store';
import { isDesktopRuntime } from '../services/ipc';
import { hasPreview } from '../services/resourceMedia';
import { normalizeInputUrl } from '../lib/url';
import { reportError } from '../lib/errors';
import { startEnrichment } from '../store/jobs/enrich';
import { startPreviewCapture } from '../store/jobs/preview';
import { resourceById, visibleResources } from '../store/selectors';

export type AddResourceOutcome = 'invalid' | 'duplicate' | 'added';

const inLibraryView = (id: string): boolean =>
  visibleResources(useAppStore.getState()).some((resource) => resource.id === id);

/** Opens the library on the record, lifting the search or scope only when they would hide it. */
const revealInLibrary = (id: string): void => {
  const store = useAppStore.getState();
  if (!inLibraryView(id)) store.setSearchQuery('');
  if (!inLibraryView(id)) store.setScope('all');
  store.goToPage('library');
  store.selectResource(id);
};

/** Link add flow: validate → dedupe by urlKey → add → enrich → capture a preview. */
export const useAddResource = () =>
  useCallback((rawUrl: string): AddResourceOutcome => {
    const t = getT();
    const store = useAppStore.getState();
    // An intranet host is accepted when the scheme was typed out explicitly, as the importer does.
    const urlOptions = { allowDotlessHost: true };
    const url = normalizeInputUrl(rawUrl, urlOptions);
    if (!url) return 'invalid';

    const desktop = isDesktopRuntime();
    const outcome = store.addResource(
      { url, ai: { status: desktop ? 'pending' : 'none' } },
      urlOptions,
    );
    if (!outcome) return 'invalid';
    if (outcome.duplicate) {
      store.selectResource(outcome.resource.id);
      store.pushToast(t.addLink.duplicate, 'info');
      return 'duplicate';
    }
    const id = outcome.resource.id;
    // Off the library, or hidden by the search or scope, the new card is out of sight.
    const reveal =
      store.page === 'library' && inLibraryView(id)
        ? undefined
        : { action: { label: t.addLink.show, run: () => revealInLibrary(id) } };
    if (!desktop) {
      store.pushToast(t.addLink.addedOffline, 'info', reveal);
      return 'added';
    }

    store.pushToast(t.addLink.added, 'success', reveal);
    void (async () => {
      try {
        // Only this link's analysis, so a bulk run in progress cannot hold up its preview.
        await startEnrichment([id], { awaitTargets: true });
        const resource = resourceById(useAppStore.getState().resources, id);
        if (resource && resource.ai.status !== 'failed' && !hasPreview(resource)) {
          await startPreviewCapture([id]);
        }
      } catch (error) {
        reportError(error, 'addResource');
      }
    })();
    return 'added';
  }, []);
