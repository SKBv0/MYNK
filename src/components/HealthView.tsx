import React, { useCallback, useId, useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Camera,
  CheckCircle2,
  ExternalLink,
  ImageOff,
  Library,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Unlink,
  Upload,
} from 'lucide-react';
import type { Resource } from '../types';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { useHealthScan } from '../hooks/useHealthScan';
import { usePreviewCapture } from '../hooks/usePreviewCapture';
import { useEnrichment } from '../hooks/useEnrichment';
import {
  categoryDistribution,
  classifyHealth,
  healthSummary,
  isProtectedResource,
  sortByCreatedAt,
  type HealthClass,
  workingPercent,
} from '../store/selectors';
import { deleteResourcesWithMedia } from '../store/jobs/preview';
import { openResource } from '../lib/resourceActions';
import { formatNumber, formatRelativeTime } from '../lib/format';
import { fmt } from '../lib/text';
import { healthReason } from '../lib/healthReason';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  INSET_SURFACE,
  IconButton,
  PageHeader,
  Progress,
  SectionTitle,
  TONE_SOFT,
  cx,
} from './ui';

const LIST_LIMIT = 150;

type IssueListKind = 'broken' | 'preview';

interface IssueRowProps {
  resource: Resource;
  listKind: IssueListKind;
  isBusy: boolean;
  onCapture: (id: string) => void;
  onUpload: (id: string) => void;
}

/** Memoized: a preview job ticking through the library re-renders only rows whose flag changed. */
const IssueRow = React.memo<IssueRowProps>(
  ({ resource, listKind, isBusy, onCapture, onUpload }) => {
    const { t } = useTranslation();
    const kind =
      listKind === 'broken' ? 'broken' : isProtectedResource(resource) ? 'protected' : 'missing';
    const reason = kind === 'broken' ? healthReason(resource.health, t) : null;

    return (
      // Wraps the actions below the text when a docked inspector leaves too little width.
      <li className={cx(INSET_SURFACE, 'flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2')}>
        <div className="min-w-0 grow basis-48">
          <p className="truncate text-base font-medium text-fg">{resource.title}</p>
          <p className="truncate text-sm text-fg-muted">{resource.url}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {reason && <Badge tone="danger">{reason}</Badge>}
          {kind !== 'broken' && (
            <>
              <Badge tone={kind === 'protected' ? 'info' : 'warning'}>
                {kind === 'protected' ? t.health.verificationWall : t.health.noImage}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                icon={Camera}
                loading={isBusy}
                onClick={() => onCapture(resource.id)}
              >
                {t.health.capture}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={Upload}
                disabled={isBusy}
                onClick={() => onUpload(resource.id)}
              >
                {t.health.upload}
              </Button>
            </>
          )}
          <IconButton
            label={t.card.openExternal}
            icon={ExternalLink}
            onClick={() => void openResource(resource)}
          />
        </div>
      </li>
    );
  },
);
IssueRow.displayName = 'IssueRow';

const IssueList: React.FC<{ items: Resource[]; kind: IssueListKind; empty: string }> = ({
  items,
  kind,
  empty,
}) => {
  const { t } = useTranslation();
  // One store subscription for the whole list instead of one per row.
  const busyIds = useAppStore((s) => s.busy.preview);
  const busy = useMemo(() => new Set(busyIds), [busyIds]);
  const { refresh, upload } = usePreviewCapture();
  const onCapture = useCallback((id: string) => void refresh(id), [refresh]);
  const onUpload = useCallback((id: string) => void upload(id), [upload]);
  if (items.length === 0) {
    return (
      <p className="flex items-center gap-2 text-base text-fg-muted">
        <CheckCircle2 size={16} aria-hidden className="text-success" />
        {empty}
      </p>
    );
  }
  return (
    <>
      <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {items.slice(0, LIST_LIMIT).map((resource) => (
          <IssueRow
            key={resource.id}
            resource={resource}
            listKind={kind}
            isBusy={busy.has(resource.id)}
            onCapture={onCapture}
            onUpload={onUpload}
          />
        ))}
      </ul>
      {items.length > LIST_LIMIT && (
        <p className="mt-2 text-sm text-fg-muted">
          {fmt(t.health.andMore, { count: items.length - LIST_LIMIT })}
        </p>
      )}
    </>
  );
};

const Stat: React.FC<{
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: 'neutral' | 'danger' | 'warning' | 'info' | 'accent';
}> = ({ label, value, icon: Icon, tone = 'neutral' }) => {
  const { locale } = useTranslation();
  return (
    <Card padding="md" className="flex items-center gap-4">
      <span
        aria-hidden
        className={cx(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
          TONE_SOFT[tone],
        )}
      >
        <Icon size={18} />
      </span>
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular-nums text-fg">
          {typeof value === 'number' ? formatNumber(value, locale) : value}
        </p>
        <p className="truncate text-sm text-fg-muted">{label}</p>
      </div>
    </Card>
  );
};

const HealthView: React.FC = () => {
  const { t, locale } = useTranslation();
  const resources = useAppStore((s) => s.resources);
  const healthMeta = useAppStore((s) => s.healthMeta);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const pushToast = useAppStore((s) => s.pushToast);
  const openSettings = useAppStore((s) => s.openSettings);
  const shareLabelId = useId();
  const health = useHealthScan();
  const preview = usePreviewCapture();
  const enrichment = useEnrichment();

  const summary = useMemo(() => healthSummary(resources), [resources]);
  const categories = useMemo(() => categoryDistribution(resources), [resources]);
  const { broken, previewIssues } = useMemo(() => {
    const sorted = sortByCreatedAt(resources);
    const inClass = (health: HealthClass) => sorted.filter((r) => classifyHealth(r) === health);
    return {
      broken: inClass('broken'),
      previewIssues: [...inClass('protected'), ...inClass('missingPreview')],
    };
  }, [resources]);
  const missingCount = summary.missingPreview;

  const scan = health.progress;
  const isScanning = health.isRunning;
  const checked = summary.total - summary.unchecked;
  const workingShare = workingPercent(checked, summary.broken);

  const statusLine =
    isScanning && scan
      ? fmt(t.health.checkStatus, {
          done: scan.done,
          total: scan.total,
          dead: scan.counters.dead ?? 0,
          protected: scan.counters.protected ?? 0,
          uncertain: scan.counters.uncertain ?? 0,
        })
      : healthMeta.lastScanAt
        ? fmt(t.health.lastCheck, {
            when: formatRelativeTime(healthMeta.lastScanAt, Date.now(), locale),
          })
        : t.health.neverChecked;

  const removeBroken = () => {
    const ids = broken.map((r) => r.id);
    if (ids.length === 0) {
      pushToast(t.health.noBroken, 'info');
      return;
    }
    requestConfirm({
      title: t.health.removeBrokenTitle,
      message: fmt(t.health.removeBrokenMessage, { count: ids.length }),
      confirmLabel: t.common.delete,
      danger: true,
      onConfirm: () => {
        const removed = deleteResourcesWithMedia(ids);
        pushToast(fmt(t.health.removedBroken, { count: removed.length }), 'success');
      },
    });
  };

  // Zero stats and disabled buttons say nothing; an empty library needs bookmarks first.
  if (resources.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-6xl flex-col gap-6">
        <PageHeader title={t.health.title} description={t.health.subtitle} />
        <EmptyState
          icon={Library}
          title={t.empty['empty-library'].title}
          description={t.empty['empty-library'].subtitle}
          actions={
            <Button variant="primary" icon={Upload} onClick={() => openSettings('data')}>
              {t.empty.import}
            </Button>
          }
          className="flex-1"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-24">
      <PageHeader title={t.health.title} description={t.health.subtitle} />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat label={t.health.totalLinks} value={summary.total} icon={Library} />
        <Stat
          label={t.health.brokenLinks}
          value={healthMeta.hasRun ? summary.broken : '–'}
          icon={Unlink}
          tone={healthMeta.hasRun && summary.broken > 0 ? 'danger' : 'neutral'}
        />
        <Stat
          label={t.health.missingPreviews}
          value={summary.missingPreview}
          icon={ImageOff}
          tone={summary.missingPreview > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label={t.health.protectedLinks}
          value={summary.protected}
          icon={ShieldAlert}
          tone={summary.protected > 0 ? 'info' : 'neutral'}
        />
        <Stat
          label={t.health.notAnalyzed}
          value={summary.notAnalyzed}
          icon={Sparkles}
          tone={summary.notAnalyzed > 0 ? 'accent' : 'neutral'}
        />
      </div>

      <Card padding="lg">
        <SectionTitle
          description={statusLine}
          actions={
            isScanning ? (
              <Button icon={Square} onClick={health.cancel}>
                {t.health.stopScan}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={Activity}
                disabled={summary.total === 0}
                onClick={() => void health.start()}
              >
                {t.health.runScan}
              </Button>
            )
          }
        >
          {t.health.checkTitle}
        </SectionTitle>
        {isScanning && scan ? (
          <Progress
            value={scan.done}
            max={scan.total}
            label={t.health.progress}
            valueText={fmt(t.jobs.progress, { done: scan.done, total: scan.total })}
            size="md"
          />
        ) : healthMeta.hasRun ? (
          <div className="space-y-2">
            <Progress
              value={workingShare}
              labelledBy={shareLabelId}
              tone={workingShare >= 90 ? 'success' : workingShare >= 70 ? 'warning' : 'danger'}
              size="md"
            />
            <p id={shareLabelId} className="text-sm text-fg-muted">
              {fmt(t.health.healthyShare, { percent: workingShare })}
            </p>
          </div>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line-subtle pt-5">
          {preview.isRunning ? (
            <Button icon={Square} onClick={preview.cancel}>
              {t.health.stopPreviews}
            </Button>
          ) : (
            <Button
              icon={RefreshCw}
              disabled={missingCount === 0}
              onClick={() => void preview.start()}
            >
              {missingCount > 0
                ? fmt(t.health.retryPreviewsCount, { count: missingCount })
                : t.health.retryPreviews}
            </Button>
          )}
          {enrichment.isRunning ? (
            <Button icon={Square} onClick={enrichment.cancel}>
              {t.health.stopEnrich}
            </Button>
          ) : (
            <Button
              icon={Sparkles}
              disabled={summary.notAnalyzed === 0}
              onClick={() => void enrichment.start()}
            >
              {summary.notAnalyzed > 0
                ? fmt(t.health.runEnrichCount, { count: summary.notAnalyzed })
                : t.health.runEnrich}
            </Button>
          )}
          <Button
            variant="danger"
            icon={Trash2}
            disabled={summary.broken === 0}
            onClick={removeBroken}
          >
            {t.health.removeBroken}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card padding="lg">
          <SectionTitle
            actions={
              <Badge tone={broken.length > 0 ? 'danger' : 'neutral'}>
                {formatNumber(broken.length, locale)}
              </Badge>
            }
          >
            {t.health.brokenLinks}
          </SectionTitle>
          <IssueList items={broken} kind="broken" empty={t.health.noBroken} />
        </Card>
        <Card padding="lg">
          <SectionTitle
            description={t.health.previewHint}
            actions={
              <Badge tone={previewIssues.length > 0 ? 'warning' : 'neutral'}>
                {formatNumber(previewIssues.length, locale)}
              </Badge>
            }
          >
            {t.health.previewIssues}
          </SectionTitle>
          <IssueList items={previewIssues} kind="preview" empty={t.health.noPreviewIssues} />
        </Card>
      </div>

      {categories.length > 0 && (
        <Card padding="lg">
          <SectionTitle description={t.health.categoryDistributionHint}>
            {t.health.categoryDistribution}
          </SectionTitle>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
            {categories.map(({ id, count }) => (
              <div key={id} className="flex flex-wrap justify-between gap-y-1.5 text-sm">
                <dt className="text-fg-secondary">{t.categories[id]}</dt>
                <dd className="tabular-nums text-fg-muted">
                  {fmt(t.health.itemsCount, { count })}
                </dd>
                <dd className="w-full">
                  <Progress
                    value={count}
                    max={summary.total}
                    label={t.categories[id]}
                    valueText={fmt(t.health.itemsCount, { count })}
                  />
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
};

export default HealthView;
