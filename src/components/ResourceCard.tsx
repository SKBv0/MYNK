import React, { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleDashed,
  Copy,
  Globe,
  RefreshCw,
} from 'lucide-react';
import type { Resource } from '../types';
import { useTranslation } from '../hooks/useTranslation';
import SmartImage from './SmartImage';
import FavoriteButton from './FavoriteButton';
import { isoDateTime } from './renderHelpers';
import { sourceLabel } from '../services/resourceMedia';
import { resourceFavicons, resourcePreviews } from '../lib/media';
import { useAppStore } from '../store';
import { isLowConfidence } from '../store/selectors';
import { formatDate } from '../lib/format';
import { fmt } from '../lib/text';
import { copyResourceMarkdown, openResource } from '../lib/resourceActions';
import { Badge, Card, CardAction, IconButton, REVEAL_ON_HOVER, Spinner, Tooltip, cx } from './ui';

interface ResourceCardProps {
  resource: Resource;
  isSelected?: boolean;
  isBatched?: boolean;
  /** Any card is batch-selected: checkboxes stay visible for fast multi-select. */
  batchMode?: boolean;
  onSelect?: (id: string) => void;
  onToggleBatch?: (id: string) => void;
  onRefreshPreview?: ((id: string) => void) | undefined;
  isRefreshingPreview?: boolean;
}

/** Fixed card height used by the virtualized grid (px). */
export const CARD_HEIGHT = 320;

/** Secondary actions stay reachable by keyboard and show on hover or focus. */
const ResourceCard: React.FC<ResourceCardProps> = ({
  resource,
  isSelected = false,
  isBatched = false,
  batchMode = false,
  onSelect,
  onToggleBatch,
  onRefreshPreview,
  isRefreshingPreview = false,
}) => {
  const { t, locale } = useTranslation();
  const mediaReady = useAppStore((s) => s.mediaReady);

  const previews = useMemo(() => resourcePreviews(resource, mediaReady), [resource, mediaReady]);
  const favicons = useMemo(() => resourceFavicons(resource, mediaReady), [resource, mediaReady]);
  const isDead = resource.health.status === 'dead';
  const isAnalyzing = resource.ai.status === 'pending';

  return (
    <Card
      as="article"
      variant="interactive"
      selected={isSelected}
      data-analyzing={isAnalyzing ? '' : undefined}
      className={cx(
        'group flex h-full flex-col overflow-hidden',
        isDead && 'opacity-70',
        isAnalyzing && 'analyzing-ring border-transparent hover:border-transparent',
      )}
    >
      <div className="relative h-32 shrink-0 overflow-hidden bg-surface-2">
        <SmartImage
          sources={previews}
          alt=""
          className="h-full w-full object-cover transition-transform duration-slow ease-out group-hover:scale-105"
          loading="lazy"
        />
        <div className="absolute left-3 right-12 top-3 flex items-center gap-1.5">
          <Badge variant="overlay">{t.categories[resource.categoryId]}</Badge>
          {isDead && (
            <Badge variant="overlay" tone="danger" icon={AlertTriangle}>
              {t.card.dead}
            </Badge>
          )}
        </div>
        <div className="absolute bottom-3 left-3 z-10">
          {resource.ai.status === 'pending' ? (
            <Badge variant="overlay" tone="accent">
              <span className="inline-flex items-center gap-1">
                <Spinner size={12} className="text-accent" />
                {t.card.analyzing}
              </span>
            </Badge>
          ) : resource.ai.status === 'failed' ? (
            <Tooltip content={resource.ai.error ?? t.card.analysisFailed}>
              <Badge variant="overlay" tone="danger" icon={AlertTriangle} tabIndex={0}>
                {t.card.analysisFailed}
              </Badge>
            </Tooltip>
          ) : isLowConfidence(resource) ? (
            <Tooltip content={t.card.lowConfidenceHint}>
              <Badge variant="overlay" tone="warning" icon={CircleDashed} tabIndex={0}>
                {t.card.lowConfidence}
              </Badge>
            </Tooltip>
          ) : null}
        </div>
        {onToggleBatch && (
          <button
            type="button"
            role="checkbox"
            aria-checked={isBatched}
            aria-label={`${isBatched ? t.card.batchDeselect : t.card.batchSelect}: ${resource.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleBatch(resource.id);
            }}
            className={cx(
              'absolute right-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-sm border-2 transition-opacity duration-fast',
              isBatched
                ? 'border-accent bg-accent text-accent-contrast opacity-100'
                : cx(
                    'border-fg-media bg-surface-media text-transparent',
                    batchMode ? 'opacity-100' : REVEAL_ON_HOVER,
                  ),
            )}
          >
            <Check size={14} strokeWidth={3} aria-hidden />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <SmartImage
            sources={favicons}
            className="h-4 w-4 shrink-0 rounded-sm object-contain"
            alt=""
            loading="lazy"
            fallback={<Globe size={14} aria-hidden className="shrink-0" />}
          />
          <span className="truncate">{sourceLabel(resource)}</span>
        </div>
        {/* The clamp sits inside the button: an inline-block button is one line box to its parent. */}
        <h3 className="mt-2 shrink-0 text-md font-semibold text-fg">
          <CardAction
            onClick={() => onSelect?.(resource.id)}
            aria-label={fmt(t.card.showDetails, { title: resource.title })}
            className="group-hover:text-accent-text"
          >
            <span className="line-clamp-2">{resource.title}</span>
          </CardAction>
        </h3>
        {resource.description && (
          <p className="mt-1 line-clamp-2 shrink-0 text-sm text-fg-muted">{resource.description}</p>
        )}

        <div className="mt-auto flex items-center justify-between pt-3">
          <time dateTime={isoDateTime(resource.createdAt)} className="text-xs text-fg-muted">
            {formatDate(resource.createdAt, locale)}
          </time>
          <div className="relative z-10 flex items-center gap-0.5">
            {onRefreshPreview && (
              <IconButton
                label={t.card.refreshPreview}
                icon={RefreshCw}
                size="xs"
                loading={isRefreshingPreview}
                className={isRefreshingPreview ? undefined : REVEAL_ON_HOVER}
                onClick={() => onRefreshPreview(resource.id)}
              />
            )}
            <IconButton
              label={t.card.copyMarkdown}
              icon={Copy}
              size="xs"
              className={REVEAL_ON_HOVER}
              onClick={() => void copyResourceMarkdown(resource)}
            />
            <IconButton
              label={t.card.openExternal}
              icon={ArrowUpRight}
              size="xs"
              className={REVEAL_ON_HOVER}
              onClick={() => void openResource(resource)}
            />
            <FavoriteButton resource={resource} size="xs" />
          </div>
        </div>
      </div>
    </Card>
  );
};

export default React.memo(ResourceCard);
