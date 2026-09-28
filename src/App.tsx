import React, { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import AppHeader from './components/layout/AppHeader';
import BatchActionDock from './components/BatchActionDock';
import ViewRouter from './components/ViewRouter';
import ResourceInspector from './components/ResourceInspector';
import AddLinkDialog from './components/AddLinkDialog';
import GlobalChatDialog from './components/GlobalChatDialog';
import SynthesisMode from './components/SynthesisMode';
import CommandPalette from './components/CommandPalette';
import ConfirmDialogHost from './components/ConfirmDialogHost';
import JobsHud from './components/JobsHud';
import { ToastRegion, cx } from './components/ui';
import { useAppStore } from './store';
import { isDockVisible } from './store/selectors';
import { hydrateStore } from './store/persistence';
import { initMediaOnce } from './store/jobs/preview';
import { startInboxWatch } from './store/jobs/inbox';
import { startUpdateWatch } from './store/jobs/update';
import { reportError } from './lib/errors';
import { useThemeVars } from './hooks/useThemeVars';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useTranslation } from './hooks/useTranslation';
import { useMediaQuery, WIDE_LAYOUT_QUERY } from './hooks/useMediaQuery';

/**
 * Loads persisted data once, then starts media maintenance, the inbox watch and the update check.
 * All three take `ok`: otherwise maintenance deletes every media file and inbox entries are lost.
 */
const useAppBootstrap = () => {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void hydrateStore()
      .then(async ({ ok }) => {
        await initMediaOnce({ libraryLoaded: ok });
        startInboxWatch({ libraryLoaded: ok });
        startUpdateWatch({ libraryLoaded: ok });
      })
      .catch((error: unknown) => reportError(error, 'bootstrap'));
  }, []);
};

/** On wide windows the inspector docks beside the content; on narrower ones it overlays it. */
const App: React.FC = () => {
  useAppBootstrap();
  useThemeVars();
  useGlobalShortcuts();
  const { t } = useTranslation();
  const selectResource = useAppStore((s) => s.selectResource);
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const page = useAppStore((s) => s.page);
  const viewMode = useAppStore((s) => s.viewMode);
  const scope = useAppStore((s) => s.scope);
  const dockVisible = useAppStore(isDockVisible);
  const [hudFootprint, setHudFootprint] = useState(0);
  // The graph fills the viewport instead of scrolling, so reserved room would only shrink it.
  const fillsViewport = page === 'library' && viewMode === 'graph';
  const clearHud = hudFootprint > 0 && !fillsViewport;
  const clearDock = !clearHud && dockVisible && !fillsViewport;

  // A new location starts at the top instead of inheriting the previous view's scroll offset.
  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [page, viewMode, scope]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-10 focus:z-titlebar focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-contrast"
      >
        {t.common.skipToContent}
      </a>
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <AppHeader />
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
              <div
                ref={contentScrollRef}
                id="main-content"
                tabIndex={-1}
                data-focus-container=""
                data-clear-selection
                className={cx(
                  'min-h-0 flex-1 overflow-y-auto px-6 py-6 xl:px-8',
                  clearDock && 'pb-24',
                )}
                style={clearHud ? { paddingBottom: hudFootprint } : undefined}
                onClick={(event) => {
                  // Clicking empty space (not a card or control) closes the inspector.
                  const target = event.target;
                  if (
                    target instanceof HTMLElement &&
                    target.dataset.clearSelection !== undefined
                  ) {
                    selectResource(null);
                  }
                }}
              >
                <div className="mx-auto h-full max-w-screen-2xl" data-clear-selection>
                  <ViewRouter scrollContainerRef={contentScrollRef} />
                  {!fillsViewport && (
                    // Overflowing content ignores the container's bottom padding; this repeats it.
                    <div
                      aria-hidden
                      data-content-end=""
                      data-clear-selection
                      className={clearHud ? undefined : clearDock ? 'h-24' : 'h-6'}
                      style={clearHud ? { height: hudFootprint } : undefined}
                    />
                  )}
                </div>
              </div>
              <BatchActionDock />
              <JobsHud onFootprintChange={setHudFootprint} />
              <ToastRegion />
            </div>
            {wide && <ResourceInspector mode="docked" />}
          </div>
        </main>
      </div>

      {!wide && <ResourceInspector mode="drawer" />}
      <AddLinkDialog />
      <GlobalChatDialog />
      <SynthesisMode />
      <CommandPalette />
      <ConfirmDialogHost />
    </div>
  );
};

export default App;
