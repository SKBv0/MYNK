import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, ImageOff, Pause, Play, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { isDockVisible, needsAnalysis, needsPreview } from '../store/selectors';
import {
  cancelEnrichment,
  pauseEnrichment,
  resumeEnrichment,
  startEnrichmentConfirmed,
} from '../store/jobs/enrich';
import {
  cancelPreviewCapture,
  pausePreviewCapture,
  resumePreviewCapture,
  startPreviewCapture,
} from '../store/jobs/preview';
import { cancelHealthScan } from '../store/jobs/health';
import { dismissJob, isJobActive } from '../store/jobs/shared';
import { isDesktopRuntime } from '../services/ipc';
import { fmt } from '../lib/text';
import { formatNumber } from '../lib/format';
import type { JobKind, JobProgress, Resource } from '../types';
import { Button, IconButton, Progress, Spinner, TONE_SOFT, cx, dockAwareBottom } from './ui';

// Cached per (immutable) record, so a bulk job re-tests only the record it just rewrote.
const flagCache = new WeakMap<Resource, { analysis: boolean; preview: boolean }>();

const flagsOf = (resource: Resource) => {
  let flags = flagCache.get(resource);
  if (!flags) {
    flags = { analysis: needsAnalysis(resource), preview: needsPreview(resource) };
    flagCache.set(resource, flags);
  }
  return flags;
};

const ACTIONS: Record<
  JobKind,
  { cancel: () => void; pause?: () => void; resume?: () => void; icon: typeof Sparkles }
> = {
  enrich: {
    cancel: cancelEnrichment,
    pause: pauseEnrichment,
    resume: resumeEnrichment,
    icon: Sparkles,
  },
  preview: {
    cancel: cancelPreviewCapture,
    pause: pausePreviewCapture,
    resume: resumePreviewCapture,
    icon: ImageOff,
  },
  health: { cancel: cancelHealthScan, icon: Activity },
};

const JobCard: React.FC<{ job: JobProgress }> = ({ job }) => {
  const { t } = useTranslation();
  const actions = ACTIONS[job.kind];
  const active = isJobActive(job);
  const title = t.jobs.titles[job.kind];
  const status =
    job.state === 'paused'
      ? t.jobs.paused
      : job.state === 'cancelled'
        ? t.jobs.cancelled
        : job.state === 'done'
          ? t.jobs.done
          : t.jobs.running;

  const detail =
    job.kind === 'health'
      ? fmt(t.jobs.healthDetail, {
          dead: job.counters.dead ?? 0,
          protected: job.counters.protected ?? 0,
          uncertain: job.counters.uncertain ?? 0,
        })
      : job.failed > 0
        ? fmt(t.jobs.failedCount, { count: job.failed })
        : job.kind === 'preview' && (job.counters.challenge ?? 0) > 0
          ? fmt(t.jobs.challengeCount, { count: job.counters.challenge ?? 0 })
          : '';
  const progressText = fmt(t.jobs.progress, { done: job.done, total: job.total });

  return (
    <li className="rounded-md border border-line bg-surface-2 p-3 shadow-lg">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cx(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm',
            active
              ? TONE_SOFT.accent
              : job.state === 'cancelled'
                ? 'bg-surface-3 text-fg-muted'
                : TONE_SOFT.success,
          )}
        >
          {job.state === 'running' ? <Spinner size={14} /> : <actions.icon size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-fg">{title}</p>
          <p className="text-sm text-fg-muted">
            {status} · {progressText}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          {job.state === 'running' && actions.pause && (
            <IconButton label={t.jobs.pause} icon={Pause} size="xs" onClick={actions.pause} />
          )}
          {job.state === 'paused' && actions.resume && (
            <IconButton label={t.jobs.resume} icon={Play} size="xs" onClick={actions.resume} />
          )}
          <IconButton
            label={active ? t.jobs.cancel : t.common.dismiss}
            icon={X}
            size="xs"
            onClick={active ? actions.cancel : () => dismissJob(job.kind)}
          />
        </div>
      </div>
      <Progress
        className="mt-3"
        value={job.done}
        max={job.total}
        label={title}
        valueText={progressText}
        tone={active ? 'accent' : job.state === 'cancelled' ? 'neutral' : 'success'}
      />
      {detail && <p className="mt-2 truncate text-sm text-fg-muted">{detail}</p>}
    </li>
  );
};

const Invite: React.FC<{
  icon: typeof Sparkles;
  text: string;
  onStart: () => void;
  onDismiss: () => void;
}> = ({ icon: Icon, text, onStart, onDismiss }) => {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-3 rounded-md border border-line bg-surface-2 py-2 pl-3 pr-2 shadow-lg">
      <Icon size={16} aria-hidden className="shrink-0 text-accent-text" />
      <p className="min-w-0 flex-1 text-sm text-fg">{text}</p>
      <Button size="sm" variant="soft" onClick={onStart}>
        {t.common.start}
      </Button>
      <IconButton label={t.common.dismiss} icon={X} size="xs" onClick={onDismiss} />
    </li>
  );
};

interface JobsHudProps {
  /** How far the HUD reaches up from the bottom of its container, in px; 0 while hidden. */
  onFootprintChange?: (px: number) => void;
}

/** Background job progress + "start" invitations, collapsible to a single line. */
const JobsHud: React.FC<JobsHudProps> = ({ onFootprintChange }) => {
  const { t, locale } = useTranslation();
  const jobs = useAppStore((s) => s.jobs);
  const resources = useAppStore((s) => s.resources);
  const dismissed = useAppStore((s) => s.dismissedInvites);
  const dismissInvite = useAppStore((s) => s.dismissInvite);
  const dockVisible = useAppStore(isDockVisible);
  const [collapsed, setCollapsed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const counts = useMemo(() => {
    let analysis = 0;
    let previews = 0;
    for (const resource of resources) {
      const flags = flagsOf(resource);
      if (flags.analysis) analysis += 1;
      if (flags.preview) previews += 1;
    }
    return { analysis, previews };
  }, [resources]);

  const desktop = isDesktopRuntime();
  const showEnrichInvite = desktop && !jobs.enrich && !dismissed.enrich && counts.analysis > 0;
  const showPreviewInvite =
    desktop && !jobs.preview && !jobs.enrich && !dismissed.preview && counts.previews > 0;
  const active = (['enrich', 'health', 'preview'] as const)
    .map((kind) => jobs[kind])
    .filter((job): job is JobProgress => job !== null);
  const total = active.length + (showEnrichInvite ? 1 : 0) + (showPreviewInvite ? 1 : 0);
  const visible = total > 0;

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!onFootprintChange) return;
    if (!visible || !section) {
      onFootprintChange(0);
      return;
    }
    const measure = () => {
      const container = section.offsetParent;
      onFootprintChange(
        container instanceof HTMLElement
          ? Math.max(0, container.clientHeight - section.offsetTop)
          : section.offsetHeight,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => {
      observer.disconnect();
      onFootprintChange(0);
    };
  }, [visible, dockVisible, onFootprintChange]);

  if (!visible) return null;

  return (
    <section
      ref={sectionRef}
      aria-label={t.jobs.region}
      className={cx(
        'absolute left-6 z-dock flex w-80 max-w-full flex-col gap-2',
        dockAwareBottom(dockVisible),
      )}
    >
      <div className="flex justify-start">
        <Button
          size="sm"
          variant="secondary"
          icon={collapsed ? ChevronUp : ChevronDown}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="shadow-md"
        >
          {t.jobs.region} · {formatNumber(total, locale)}
        </Button>
      </div>
      {!collapsed && (
        <ul className="flex flex-col gap-2">
          {active.map((job) => (
            <JobCard key={job.kind} job={job} />
          ))}
          {showEnrichInvite && (
            <Invite
              icon={Sparkles}
              text={fmt(t.jobs.inviteEnrich, { count: counts.analysis })}
              onStart={() => void startEnrichmentConfirmed()}
              onDismiss={() => dismissInvite('enrich')}
            />
          )}
          {showPreviewInvite && (
            <Invite
              icon={ImageOff}
              text={fmt(t.jobs.invitePreview, { count: counts.previews })}
              onStart={() => void startPreviewCapture()}
              onDismiss={() => dismissInvite('preview')}
            />
          )}
        </ul>
      )}
    </section>
  );
};

export default JobsHud;
