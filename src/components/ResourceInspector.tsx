import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  CornerDownRight,
  ExternalLink,
  Info,
  Pencil,
  RefreshCw,
  Sparkles,
  Unlink,
  Upload,
  X,
} from 'lucide-react';
import SmartImage from './SmartImage';
import FavoriteButton from './FavoriteButton';
import AICopilot from './AICopilot';
import type { Resource } from '../types';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { usePreviewCapture } from '../hooks/usePreviewCapture';
import { isCollectionMember, isLowConfidence, resourceById } from '../store/selectors';
import { resourcePreviews } from '../lib/media';
import { copyToClipboard } from '../lib/errors';
import { openResource } from '../lib/resourceActions';
import { fmt } from '../lib/text';
import { healthReason } from '../lib/healthReason';
import { canonicalUrlKey, hasCredentials, shortAddress } from '../lib/url';
import { startEnrichment } from '../store/jobs/enrich';
import {
  Badge,
  Button,
  Drawer,
  INSET_SURFACE,
  IconButton,
  Input,
  Spinner,
  TONE_PANEL,
  Tooltip,
  cx,
} from './ui';
import { restoreFocus } from './ui/focus';
import { keyedLines } from './renderHelpers';

const TitleEditor: React.FC<{ resource: Resource }> = ({ resource }) => {
  const { t } = useTranslation();
  const updateResource = useAppStore((s) => s.updateResource);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== resource.title) {
      updateResource(resource.id, { title: draft }, { byUser: true });
    }
    setDraft(null);
  };

  return (
    <div className="flex items-start gap-2">
      {draft === null ? (
        <h3 className="min-w-0 flex-1 break-words text-lg font-semibold text-fg">
          {resource.title}
        </h3>
      ) : (
        <Input
          autoFocus
          value={draft}
          label={t.inspector.titleField}
          hideLabel
          containerClassName="flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              // Cancel the edit only; do not close the panel.
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      )}
      <IconButton
        label={t.inspector.editTitle}
        icon={Pencil}
        onClick={() => setDraft(resource.title)}
      />
      <FavoriteButton resource={resource} />
    </div>
  );
};

const AiStatusLine: React.FC<{ resource: Resource }> = ({ resource }) => {
  const { t } = useTranslation();
  const { status, error } = resource.ai;
  if (status === 'ok' && !isLowConfidence(resource)) return null;

  const text =
    status === 'pending'
      ? t.inspector.aiPending
      : status === 'failed'
        ? `${t.inspector.aiFailed}${error ? `: ${error}` : ''}`
        : status === 'insufficient'
          ? t.inspector.aiInsufficient
          : status === 'none'
            ? t.inspector.aiNone
            : t.card.lowConfidenceHint;

  return (
    <div
      role="status"
      className={cx(
        'flex items-center gap-3 rounded-md border px-3 py-2 text-sm',
        status === 'failed'
          ? cx(TONE_PANEL.danger, 'text-fg')
          : 'border-line bg-surface-2 text-fg-secondary',
      )}
    >
      {status === 'pending' ? (
        <Spinner size={14} className="shrink-0 text-accent-text" />
      ) : status === 'insufficient' ? (
        // Not a failure: the page has no readable text, so this is an explanation.
        <Info size={14} aria-hidden className="shrink-0 text-fg-muted" />
      ) : (
        <AlertTriangle
          size={14}
          aria-hidden
          className={cx('shrink-0', status === 'failed' ? 'text-danger' : 'text-fg-muted')}
        />
      )}
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {status !== 'pending' && (
        <Button
          size="sm"
          variant="soft"
          icon={Sparkles}
          onClick={() => void startEnrichment([resource.id])}
        >
          {status === 'none' ? t.inspector.analyze : t.inspector.reanalyze}
        </Button>
      )}
    </div>
  );
};

/** Why the last check found the link broken. */
const BrokenLine: React.FC<{ resource: Resource }> = ({ resource }) => {
  const { t } = useTranslation();
  if (resource.health.status !== 'dead') return null;
  const reason = healthReason(resource.health, t);
  return (
    // No live region: this line is already on screen when the panel opens, it never updates.
    <div
      className={cx(
        'flex items-center gap-3 rounded-md border px-3 py-2 text-sm text-fg',
        TONE_PANEL.danger,
      )}
    >
      <Unlink size={14} aria-hidden className="shrink-0 text-danger" />
      <span className="min-w-0 flex-1 break-words">
        {reason ? `${t.inspector.brokenLink}: ${reason}` : t.inspector.brokenLink}
      </span>
    </div>
  );
};

/** The last check or analysis ended on another address: offer it, or the record that has it. */
const RedirectLine: React.FC<{ resource: Resource }> = ({ resource }) => {
  const { t } = useTranslation();
  const finalUrl = useAppStore((s) => s.finalUrls[resource.urlKey]);
  const targetKey = useMemo(() => (finalUrl ? canonicalUrlKey(finalUrl) : null), [finalUrl]);
  const saved = useAppStore((s) =>
    targetKey === null ? null : (s.resources.find((r) => r.urlKey === targetKey) ?? null),
  );
  const updateResource = useAppStore((s) => s.updateResource);
  const selectResource = useAppStore((s) => s.selectResource);
  const pushToast = useAppStore((s) => s.pushToast);
  if (!finalUrl || saved?.id === resource.id) return null;
  // A target with `user:password@` carries credentials and is never offered as an address.
  if (hasCredentials(finalUrl)) return null;

  const address = shortAddress(finalUrl);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-secondary">
      <CornerDownRight size={14} aria-hidden className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate">
        <Tooltip content={finalUrl} describe={false}>
          <span tabIndex={0}>{fmt(t.inspector.redirectsTo, { address })}</span>
        </Tooltip>
        {saved && ` ${fmt(t.inspector.redirectTargetSaved, { title: saved.title })}`}
      </span>
      {saved ? (
        <Button
          size="sm"
          variant="soft"
          aria-label={fmt(t.inspector.openSavedFor, { address })}
          onClick={() => selectResource(saved.id)}
        >
          {t.inspector.openSaved}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="soft"
          aria-label={fmt(t.inspector.useAddressFor, { address })}
          onClick={() => {
            updateResource(resource.id, { url: finalUrl });
            pushToast(t.inspector.addressUpdated, 'success');
          }}
        >
          {t.inspector.useAddress}
        </Button>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2">
    <h4 className="text-overline">{title}</h4>
    {children}
  </section>
);

const InspectorBody: React.FC<{
  resource: Resource;
  onClose: () => void;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
}> = ({ resource, onClose, headingRef }) => {
  const { t } = useTranslation();
  const collections = useAppStore((s) => s.collections);
  const togglePin = useAppStore((s) => s.togglePin);
  const mediaReady = useAppStore((s) => s.mediaReady);
  const isBusy = useAppStore((s) => s.busy.preview.includes(resource.id));
  const preview = usePreviewCapture();
  const keywordHintId = useId();

  const previews = useMemo(() => resourcePreviews(resource, mediaReady), [resource, mediaReady]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line-subtle pl-5 pr-3">
        <h2
          ref={headingRef}
          tabIndex={-1}
          data-focus-container=""
          className="text-base font-semibold text-fg"
        >
          {t.inspector.heading}
        </h2>
        <IconButton label={t.inspector.close} icon={X} onClick={onClose} tooltipSide="left" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-5 p-5">
          <div className={cx(INSET_SURFACE, 'group relative aspect-video overflow-hidden')}>
            <SmartImage
              sources={previews}
              className="h-full w-full object-cover"
              alt={resource.title}
              loading="lazy"
            />
            <div className="absolute bottom-2 right-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
              <IconButton
                label={t.card.refreshPreview}
                icon={RefreshCw}
                variant="overlay"
                loading={isBusy}
                onClick={() => void preview.refresh(resource.id)}
              />
              <IconButton
                label={t.inspector.uploadPreview}
                icon={Upload}
                variant="overlay"
                disabled={isBusy}
                onClick={() => void preview.upload(resource.id)}
              />
            </div>
          </div>

          <div className="space-y-3">
            <TitleEditor resource={resource} />
            <AiStatusLine resource={resource} />
            <BrokenLine resource={resource} />
            <RedirectLine resource={resource} />
            {resource.description && (
              <p className="text-base text-fg-secondary">{resource.description}</p>
            )}
            <div className="flex items-center gap-1">
              {/* Truncated line; the tooltip shows the whole address on hover or focus. */}
              <Tooltip content={resource.url} describe={false}>
                <p
                  tabIndex={0}
                  className="min-w-0 flex-1 truncate rounded-sm bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg-muted"
                >
                  {resource.url}
                </p>
              </Tooltip>
              <IconButton
                label={t.inspector.copyUrl}
                icon={Copy}
                onClick={() => void copyToClipboard(resource.url, t.inspector.urlCopied)}
              />
              <IconButton
                label={t.card.openExternal}
                icon={ExternalLink}
                onClick={() => void openResource(resource)}
              />
            </div>
          </div>

          {resource.tags.length > 0 && (
            <Section title={t.inspector.tags}>
              <ul className="flex flex-wrap gap-1.5">
                {resource.tags.map((tag) => (
                  <li key={tag}>
                    <Badge>#{tag}</Badge>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {resource.folderPath.length > 0 && (
            <Section title={t.inspector.folder}>
              <p className="text-sm text-fg-secondary">{resource.folderPath.join(' › ')}</p>
            </Section>
          )}

          {resource.summary.length > 0 && (
            <Section title={t.card.keyInsights}>
              <ul className="list-disc space-y-1.5 pl-5 text-base text-fg-secondary marker:text-accent-text">
                {keyedLines(resource.summary).map(({ key, line }) => (
                  <li key={key}>{line}</li>
                ))}
              </ul>
            </Section>
          )}

          {collections.length > 0 && (
            <Section title={t.inspector.collections}>
              <p id={keywordHintId} className="sr-only">
                {t.inspector.matchedByKeyword}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {collections.map((collection) => {
                  const isPinned = collection.pinnedIds.includes(resource.id);
                  const byKeyword = !isPinned && isCollectionMember(resource, collection);
                  return (
                    <li key={collection.id}>
                      <Tooltip
                        content={fmt(isPinned ? t.inspector.unpin : t.inspector.pin, {
                          name: collection.name,
                        })}
                        describe={false}
                      >
                        <button
                          type="button"
                          onClick={() => togglePin(collection.id, resource.id)}
                          aria-pressed={isPinned}
                          aria-describedby={byKeyword ? keywordHintId : undefined}
                          className={cx(
                            'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-sm transition-colors duration-fast',
                            isPinned
                              ? 'border-accent bg-accent-soft text-accent-text'
                              : byKeyword
                                ? 'border-line bg-surface-2 text-fg-secondary hover:border-line-strong'
                                : 'border-line-subtle text-fg-muted hover:border-line-strong hover:text-fg',
                          )}
                        >
                          {isPinned && <Check size={12} aria-hidden />}
                          {collection.name}
                        </button>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>
      </div>
      <div className="flex max-h-inspector-chat shrink-0 flex-col border-t border-line-subtle">
        <AICopilot key={resource.id} contextResource={resource} variant="sheet" />
      </div>
    </div>
  );
};

/** Detail panel: `docked` sits beside the content, `drawer` overlays it. */
const ResourceInspector: React.FC<{ mode: 'docked' | 'drawer' }> = ({ mode }) => {
  const { t } = useTranslation();
  const resource = useAppStore((s) => resourceById(s.resources, s.selectedResourceId) ?? null);
  const selectResource = useAppStore((s) => s.selectResource);
  const close = () => selectResource(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const open = resource !== null;
  const resourceId = resource?.id ?? null;

  // Docked mode manages focus itself (the Drawer does it for the overlay mode).
  useEffect(() => {
    if (mode !== 'docked') return undefined;
    if (!resourceId) return undefined;
    const active = document.activeElement;
    if (!headingRef.current?.closest('aside')?.contains(active)) triggerRef.current = active;
    headingRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [mode, resourceId]);

  useEffect(() => {
    if (mode === 'docked' && !open && triggerRef.current) {
      restoreFocus(triggerRef.current);
      triggerRef.current = null;
    }
  }, [mode, open]);

  if (mode === 'drawer') {
    return (
      <Drawer open={open} onClose={close} label={t.inspector.label}>
        {resource && <InspectorBody key={resource.id} resource={resource} onClose={close} />}
      </Drawer>
    );
  }

  if (!resource) return null;
  return (
    <aside
      role="complementary"
      aria-label={t.inspector.label}
      className="flex w-inspector shrink-0 animate-drawer-in flex-col border-l border-line-subtle bg-surface-1"
    >
      <InspectorBody
        key={resource.id}
        resource={resource}
        onClose={close}
        headingRef={headingRef}
      />
    </aside>
  );
};

export default ResourceInspector;
