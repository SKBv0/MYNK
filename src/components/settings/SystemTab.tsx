import React, { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { CircleAlert, CircleCheck, Download, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { refreshSnapshotCacheBytes, resetLibraryWithMedia } from '../../store/jobs/preview';
import { dismissUpdateAnnouncement, installUpdate } from '../../store/jobs/update';
import { checkForUpdate } from '../../services/updater';
import { openExternalUrl } from '../../services/aiService';
import { isDesktopRuntime, toIpcError } from '../../services/ipc';
import { errorMessage, reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import { formatBytes } from '../../lib/format';
import { useTranslation } from '../../hooks/useTranslation';
import { Button, Card, SectionTitle } from '../ui';

const THIRD_PARTY_NOTICES_URL = 'https://github.com/SKBv0/mynk/blob/main/THIRD-PARTY-NOTICES.md';

type CheckOutcome =
  | { state: 'upToDate' }
  /** The release server has nothing for this platform yet; that is an answer, not a failure. */
  | { state: 'noRelease' }
  | { state: 'available'; version: string }
  | { state: 'failed'; message: string };

const isMissingRelease = (error: unknown): boolean => {
  const ipcError = toIpcError(error);
  return ipcError.kind === 'notFound' || ipcError.detail?.key === 'updateUnavailable';
};

/** The installed version and a manual update check; failures show only here, on request. */
const UpdateCard: React.FC = () => {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    void getVersion()
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch((error: unknown) => reportError(error, 'update.version', { toast: false }));
    return () => {
      active = false;
    };
  }, []);

  const check = async () => {
    setChecking(true);
    setOutcome(null);
    // This check replaces the handle the announcement's install action would have used.
    dismissUpdateAnnouncement();
    try {
      const update = await checkForUpdate();
      setOutcome(update ? { state: 'available', version: update.version } : { state: 'upToDate' });
    } catch (error) {
      reportError(error, 'update.check.manual', { toast: false });
      setOutcome(
        isMissingRelease(error)
          ? { state: 'noRelease' }
          : { state: 'failed', message: errorMessage(error) },
      );
    } finally {
      setChecking(false);
    }
  };

  const u = t.updates;
  return (
    <Card padding="lg" className="space-y-4">
      <SectionTitle description={u.description}>{u.title}</SectionTitle>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-base text-fg-secondary">
          {u.currentVersion}:{' '}
          <span className="font-medium text-fg">{version ?? u.versionUnknown}</span>
        </p>
        <Button icon={RefreshCw} loading={checking} onClick={() => void check()}>
          {checking ? u.checking : u.check}
        </Button>
      </div>

      <div className="space-y-1 border-t border-line-subtle pt-4">
        <h3 className="text-base font-semibold text-fg">{t.settings.advanced.aboutTitle}</h3>
        <p className="text-sm text-fg-muted">{t.settings.advanced.aboutLicence}</p>
        <Button
          size="sm"
          variant="ghost"
          icon={ExternalLink}
          onClick={() =>
            void openExternalUrl(THIRD_PARTY_NOTICES_URL).catch((error: unknown) =>
              reportError(error, 'about.notices'),
            )
          }
        >
          {t.settings.advanced.aboutNotices}
        </Button>
      </div>

      {outcome && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 border-t border-line-subtle pt-4"
        >
          {(outcome.state === 'upToDate' || outcome.state === 'noRelease') && (
            <p className="flex items-center gap-2 text-base text-fg-secondary">
              <CircleCheck size={16} aria-hidden className="shrink-0 text-success" />
              {outcome.state === 'upToDate' ? u.upToDate : u.noRelease}
            </p>
          )}
          {outcome.state === 'available' && (
            <>
              <p className="flex items-center gap-2 text-base text-fg-secondary">
                <Download size={16} aria-hidden className="shrink-0 text-accent-text" />
                {fmt(u.available, { version: outcome.version })}
              </p>
              <Button
                icon={Download}
                variant="primary"
                onClick={() => void installUpdate(outcome.version)}
              >
                {u.install}
              </Button>
            </>
          )}
          {outcome.state === 'failed' && (
            <p className="flex items-center gap-2 text-base text-fg-secondary">
              <CircleAlert size={16} aria-hidden className="shrink-0 text-warning" />
              {`${u.checkFailed}: ${outcome.message}`}
            </p>
          )}
        </div>
      )}
    </Card>
  );
};

/**
 * Update check and the library reset (behind a confirmation). The preview cache size is re-read
 * each time the tab is shown.
 */
const SystemTab: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useTranslation();
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const pushToast = useAppStore((s) => s.pushToast);
  const cacheBytes = useAppStore((s) => s.snapshotCacheBytes);
  useEffect(() => {
    if (active) void refreshSnapshotCacheBytes();
  }, [active]);

  const reset = () =>
    requestConfirm({
      title: t.settings.advanced.confirmTitle,
      message: t.settings.advanced.confirmMessage,
      confirmLabel: t.settings.advanced.confirmLabel,
      danger: true,
      onConfirm: () => {
        void resetLibraryWithMedia().then((outcome) => {
          const a = t.settings.advanced;
          if (outcome.state === 'blocked') pushToast(a.blocked, 'error');
          else if (outcome.state === 'filesFailed') {
            reportError(outcome.error, 'snapshots.reset', { prefix: a.filesFailed });
          } else {
            const count = outcome.deletedFiles;
            pushToast(count ? fmt(a.doneWithFiles, { count }) : a.done, 'success');
          }
        });
      },
    });

  return (
    <div className="space-y-4">
      <UpdateCard />
      <section className="rounded-lg border border-danger/30 bg-surface-1 p-6">
        <SectionTitle description={t.settings.advanced.description}>
          {t.settings.advanced.title}
        </SectionTitle>
        <div className="mb-5 space-y-1">
          <p className="text-base text-fg-secondary">{t.settings.advanced.backupFirst}</p>
          {cacheBytes !== null && (
            <p className="text-sm text-fg-muted">
              {fmt(t.settings.advanced.cacheSize, { size: formatBytes(cacheBytes) })}
            </p>
          )}
        </div>
        <Button variant="danger" icon={Trash2} onClick={reset}>
          {t.settings.advanced.button}
        </Button>
      </section>
    </div>
  );
};

export default SystemTab;
