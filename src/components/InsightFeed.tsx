import React, { useMemo, useState } from 'react';
import { CircleDashed, Globe, Sparkles } from 'lucide-react';
import type { Resource } from '../types';
import SmartImage from './SmartImage';
import FavoriteButton from './FavoriteButton';
import { sourceLabel } from '../services/resourceMedia';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { feedResources, isLowConfidence } from '../store/selectors';
import { resourceFavicons, resourcePreviews } from '../lib/media';
import { formatDate } from '../lib/format';
import { fmt } from '../lib/text';
import { Badge, Button, Card, CardAction, EmptyState, Tooltip } from './ui';
import { isoDateTime, keyedLines } from './renderHelpers';

interface InsightFeedProps {
  resources: Resource[];
  onNavigateToItem: (id: string) => void;
}

const PAGE_SIZE = 40;

const FeedCard: React.FC<{ resource: Resource; onOpen: (id: string) => void }> = React.memo(
  ({ resource, onOpen }) => {
    const { t, locale } = useTranslation();
    const mediaReady = useAppStore((s) => s.mediaReady);
    const previews = useMemo(() => resourcePreviews(resource, mediaReady), [resource, mediaReady]);
    const favicons = useMemo(() => resourceFavicons(resource, mediaReady), [resource, mediaReady]);
    const iso = isoDateTime(resource.createdAt);

    return (
      <Card as="article" variant="interactive" className="group flex gap-5 p-5">
        <SmartImage
          sources={previews}
          className="hidden h-28 w-44 shrink-0 rounded-md object-cover lg:block"
          alt=""
          loading="lazy"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <SmartImage
                  sources={favicons}
                  className="h-4 w-4 shrink-0 rounded-sm"
                  alt=""
                  fallback={<Globe size={14} aria-hidden />}
                />
                <span className="truncate">{sourceLabel(resource)}</span>
                {iso && (
                  <>
                    <span aria-hidden>·</span>
                    <time dateTime={iso}>{formatDate(resource.createdAt, locale)}</time>
                  </>
                )}
              </div>
              <h3 className="mt-1 text-md font-semibold text-fg">
                <CardAction
                  onClick={() => onOpen(resource.id)}
                  aria-label={fmt(t.card.showDetails, { title: resource.title })}
                  className="group-hover:text-accent-text"
                >
                  {resource.title}
                </CardAction>
              </h3>
            </div>
            <div className="relative z-10 flex shrink-0 items-center gap-1.5">
              <Badge tone="accent">{t.categories[resource.categoryId]}</Badge>
              <FavoriteButton resource={resource} size="xs" />
            </div>
          </div>

          {resource.description && (
            <p className="line-clamp-2 text-base text-fg-secondary">{resource.description}</p>
          )}

          <ul className="list-disc space-y-1 pl-5 text-base text-fg-secondary marker:text-accent-text">
            {keyedLines(resource.summary).map(({ key, line }) => (
              <li key={key}>{line}</li>
            ))}
          </ul>

          {(resource.tags.length > 0 || isLowConfidence(resource)) && (
            <div className="flex flex-wrap gap-1.5">
              {isLowConfidence(resource) && (
                <Tooltip content={t.card.lowConfidenceHint}>
                  <Badge tone="warning" icon={CircleDashed} tabIndex={0} className="relative z-10">
                    {t.card.lowConfidence}
                  </Badge>
                </Tooltip>
              )}
              {resource.tags.map((tag) => (
                <Badge key={tag}>#{tag}</Badge>
              ))}
            </div>
          )}
        </div>
      </Card>
    );
  },
);
FeedCard.displayName = 'FeedCard';

/** AI summaries of analyzed bookmarks, newest first, paginated. */
const InsightFeed: React.FC<InsightFeedProps> = ({ resources, onNavigateToItem }) => {
  const { t } = useTranslation();
  // Paging restarts when the scope or the search changes (not when a record is rewritten).
  const filterKey = useAppStore(
    (s) =>
      `${typeof s.scope === 'string' ? s.scope : `collection:${s.scope.collectionId}`}|${s.searchQuery}`,
  );
  const [page, setPage] = useState({ filterKey, visible: PAGE_SIZE });
  const visible = page.filterKey === filterKey ? page.visible : PAGE_SIZE;
  const analysed = useMemo(() => feedResources(resources), [resources]);

  if (analysed.length === 0) {
    return <EmptyState icon={Sparkles} title={t.feed.emptyTitle} description={t.feed.emptyHint} />;
  }

  return (
    <div className="mx-auto max-w-4xl pb-24">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-fg">{t.feed.title}</h2>
        <span className="text-sm text-fg-muted">
          {fmt(t.feed.count, { count: analysed.length })}
        </span>
      </div>
      <ul className="space-y-3">
        {analysed.slice(0, visible).map((resource) => (
          <li key={resource.id}>
            <FeedCard resource={resource} onOpen={onNavigateToItem} />
          </li>
        ))}
      </ul>
      {visible < analysed.length && (
        <div className="flex justify-center pt-6">
          <Button onClick={() => setPage({ filterKey, visible: visible + PAGE_SIZE })}>
            {fmt(t.feed.showMore, { count: analysed.length - visible })}
          </Button>
        </div>
      )}
    </div>
  );
};

export default InsightFeed;
