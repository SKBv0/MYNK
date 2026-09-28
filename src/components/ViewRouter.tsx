import React, { useDeferredValue, useMemo } from 'react';
import { Brain, FileWarning, FolderOpen, Plus, SearchX, Star, Upload } from 'lucide-react';
import { useAppStore } from '../store';
import { activeCollectionOf, filterMemoized } from '../store/selectors';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useTranslation } from '../hooks/useTranslation';
import { refreshPreview } from '../store/jobs/preview';
import { isLibraryWriteBlocked } from '../store/persistence';
import { modifierKeyLabel } from '../lib/platform';
import { fmt } from '../lib/text';
import SettingsView from './SettingsView';
import HealthView from './HealthView';
import CollectionsView from './CollectionsView';
import InsightFeed from './InsightFeed';
import GraphView from './GraphView';
import TimelineView from './TimelineView';
import VirtualizedResourceGrid, { GridSkeleton } from './VirtualizedResourceGrid';
import { Button, EmptyState } from './ui';

interface ViewRouterProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

const SEARCH_DEBOUNCE_MS = 150;

type EmptyVariant =
  'empty-library' | 'no-results' | 'no-favorites' | 'empty-collection' | 'unreadable-library';

const EMPTY_ICONS = {
  'empty-library': Brain,
  'no-results': SearchX,
  'no-favorites': Star,
  'empty-collection': FolderOpen,
  'unreadable-library': FileWarning,
} as const;

/** Distinct empty states: empty library ≠ no search results ≠ empty scope. */
const LibraryEmptyState: React.FC<{ variant: EmptyVariant; onClear: () => void }> = ({
  variant,
  onClear,
}) => {
  const { t } = useTranslation();
  const openModal = useAppStore((s) => s.openModal);
  const openSettings = useAppStore((s) => s.openSettings);
  const copy = t.empty[variant];

  // An unreadable library offers nothing to do here: importing would be discarded unsaved.
  const actions =
    variant === 'unreadable-library' ? undefined : variant === 'empty-library' ? (
      <>
        <Button variant="primary" icon={Plus} onClick={() => openModal('addLink')}>
          {t.common.addNew}
        </Button>
        <Button icon={Upload} onClick={() => openSettings('data')}>
          {t.empty.import}
        </Button>
      </>
    ) : (
      <Button onClick={onClear}>{t.empty.clearFilters}</Button>
    );

  return (
    <EmptyState
      icon={EMPTY_ICONS[variant]}
      title={copy.title}
      description={copy.subtitle}
      actions={actions}
      footer={
        variant === 'empty-library' ? fmt(t.empty.tip, { mod: modifierKeyLabel() }) : undefined
      }
      className="h-full"
    />
  );
};

/** Library views share one filter: scope (all / favorites / collection) × search. */
const LibraryViews: React.FC<ViewRouterProps> = ({ scrollContainerRef }) => {
  const resources = useAppStore((s) => s.resources);
  const viewMode = useAppStore((s) => s.viewMode);
  const scope = useAppStore((s) => s.scope);
  const activeCollection = useAppStore(activeCollectionOf);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const selectedResourceId = useAppStore((s) => s.selectedResourceId);
  const selectResource = useAppStore((s) => s.selectResource);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setScope = useAppStore((s) => s.setScope);

  const query = useDeferredValue(useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS));
  const favoritesOnly = scope === 'favorites';
  const filtered = useMemo(
    () => filterMemoized(resources, { query, collection: activeCollection, favoritesOnly }),
    [resources, query, activeCollection, favoritesOnly],
  );

  if (filtered.length === 0) {
    const variant: EmptyVariant =
      resources.length === 0
        ? isLibraryWriteBlocked()
          ? 'unreadable-library'
          : 'empty-library'
        : query.trim()
          ? 'no-results'
          : favoritesOnly
            ? 'no-favorites'
            : activeCollection
              ? 'empty-collection'
              : 'no-results';
    return (
      <LibraryEmptyState
        variant={variant}
        onClear={() => {
          setSearchQuery('');
          setScope('all');
        }}
      />
    );
  }

  switch (viewMode) {
    case 'feed':
      return <InsightFeed resources={filtered} onNavigateToItem={selectResource} />;
    case 'graph':
      return (
        <GraphView
          resources={filtered}
          onSelect={selectResource}
          selectedResourceId={selectedResourceId}
        />
      );
    case 'timeline':
      return (
        <TimelineView
          resources={filtered}
          onSelect={selectResource}
          scrollContainerRef={scrollContainerRef}
        />
      );
    default:
      return (
        <VirtualizedResourceGrid
          resources={filtered}
          onRefreshPreview={refreshPreview}
          scrollContainerRef={scrollContainerRef}
        />
      );
  }
};

const ViewRouter: React.FC<ViewRouterProps> = ({ scrollContainerRef }) => {
  const hydrated = useAppStore((s) => s.hydrated);
  const page = useAppStore((s) => s.page);
  if (!hydrated) return <GridSkeleton />;
  if (page === 'settings') return <SettingsView />;
  if (page === 'health') return <HealthView />;
  if (page === 'collections') return <CollectionsView />;
  return <LibraryViews scrollContainerRef={scrollContainerRef} />;
};

export default ViewRouter;
