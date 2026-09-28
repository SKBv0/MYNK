import React, { useEffect, useRef, useState } from 'react';
import {
  ArchiveRestore,
  Download,
  FileCode2,
  FileJson,
  Scan,
  SearchX,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { DetectedProfile, ImportedBookmark } from '../../services/ipcTypes';
import { detectBrowsers, readBrowserBookmarks } from '../../services/browserDetection';
import { BookmarkFileError, parseBookmarkFile } from '../../services/bookmarkParser';
import { exportLibrary, revealInFolder } from '../../services/library';
import { useAppStore } from '../../store';
import type { ImportOutcome } from '../../store/slices/library';
import type { RestoreMode } from '../../store/restore';
import { startEnrichmentConfirmed } from '../../store/jobs/enrich';
import { isLibraryWriteBlocked } from '../../store/persistence';
import { isJobActive } from '../../store/jobs/shared';
import { useTranslation } from '../../hooks/useTranslation';
import { errorKind, errorMessage, reportError } from '../../lib/errors';
import { fmt } from '../../lib/text';
import { formatDate } from '../../lib/format';
import { downloadText } from '../../lib/download';
import {
  BackupError,
  backupToJson,
  exportFileName,
  parseBackup,
  toNetscapeHtml,
  type ParsedBackup,
} from '../../lib/export';
import {
  Button,
  Card,
  Checkbox,
  INSET_SURFACE,
  IconButton,
  SectionTitle,
  SegmentedControl,
  TONE_PANEL,
  cx,
} from '../ui';

const BROWSER_LABELS: Record<DetectedProfile['browser'], string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  firefox: 'Firefox',
};

const ImportSection: React.FC = () => {
  const { t } = useTranslation();
  const pushToast = useAppStore((s) => s.pushToast);
  const importBookmarks = useAppStore((s) => s.importBookmarks);
  const [busy, setBusy] = useState<null | 'detect' | 'import'>(null);
  const [profiles, setProfiles] = useState<DetectedProfile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Once an analysis run starts the invitation has done its job, whether it finishes or not.
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        if (isJobActive(state.jobs.enrich) && !isJobActive(previous.jobs.enrich)) {
          setLastImport(null);
        }
      }),
    [],
  );

  /**
   * "Nothing found" and "all of it is already here" are different answers; neither is an error.
   * `failures` are unreadable profiles; `unusable` counts links the parser already left out.
   */
  const finishImport = async (
    items: ImportedBookmark[],
    emptyText: string,
    failures: string[] = [],
    unusable = 0,
  ) => {
    const report = (text: string, type: 'success' | 'info') =>
      pushToast([text, ...failures].join(' · '), failures.length > 0 ? 'info' : type);
    if (items.length === 0) {
      if (unusable > 0) {
        report(
          fmt(t.settings.data.importResult, { added: 0, merged: 0, skipped: unusable }),
          'info',
        );
      } else if (failures.length > 0) pushToast(failures.join(' · '), 'error');
      else pushToast(emptyText, 'info');
      return;
    }
    // No success toast: nothing is saved while the library file is unreadable.
    if (isLibraryWriteBlocked()) {
      pushToast(t.settings.data.importBlocked, 'error');
      return;
    }
    const imported = await importBookmarks(items);
    const outcome = { ...imported, skipped: imported.skipped + unusable };
    setLastImport(outcome);
    if (outcome.added === 0 && outcome.merged === 0 && outcome.skipped === 0) {
      report(emptyText, 'info');
    } else if (outcome.added === 0 && outcome.skipped === 0) {
      report(t.settings.data.nothingNew, 'info');
    } else {
      report(fmt(t.settings.data.importResult, outcome), outcome.added > 0 ? 'success' : 'info');
    }
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('import');
    try {
      const parsed = await parseBookmarkFile(file);
      await finishImport(parsed.bookmarks, t.settings.data.nothingFound, [], parsed.skipped);
    } catch (error) {
      if (error instanceof BookmarkFileError) {
        pushToast(
          `${t.settings.data.importFailed}: ${t.settings.data.importErrors[error.code]}`,
          'error',
        );
      } else {
        reportError(error, 'import.file', { prefix: t.settings.data.importFailed });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleDetect = async () => {
    setBusy('detect');
    try {
      const found = await detectBrowsers();
      setProfiles(found);
      setSelected(new Set());
      // An empty result stays on screen below instead of vanishing with a toast.
      if (found.length > 0) {
        pushToast(fmt(t.settings.data.profilesFound, { count: found.length }), 'success');
      }
    } catch (error) {
      reportError(error, 'import.detect', { prefix: t.settings.data.detectFailed });
    } finally {
      setBusy(null);
    }
  };

  const handleImportSelected = async () => {
    if (selected.size === 0) return;
    setBusy('import');
    const items: ImportedBookmark[] = [];
    const failures: string[] = [];
    try {
      for (const profile of profiles ?? []) {
        if (!selected.has(profile.id)) continue;
        try {
          for (const item of await readBrowserBookmarks(profile.id)) items.push(item);
        } catch (error) {
          reportError(error, 'import.profile', { toast: false });
          failures.push(
            `${BROWSER_LABELS[profile.browser]} ${profile.profileName}: ${errorMessage(error)}`,
          );
        }
      }
      if (items.length > 0 && !isLibraryWriteBlocked()) setProfiles(null);
      await finishImport(items, t.settings.data.nothingFoundProfile, failures);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card padding="lg" className="space-y-5">
      <SectionTitle description={t.settings.data.importHint}>
        {t.settings.data.importTitle}
      </SectionTitle>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className={cx(INSET_SURFACE, 'space-y-3 p-4')}>
          <h3 className="text-base font-semibold text-fg">{t.settings.data.browserTitle}</h3>
          <p className="text-sm text-fg-muted">{t.settings.data.browserHint}</p>
          <Button
            icon={Scan}
            loading={busy === 'detect'}
            disabled={busy !== null}
            onClick={() => void handleDetect()}
          >
            {busy === 'detect' ? t.settings.data.detecting : t.settings.data.detect}
          </Button>
        </div>
        <div className={cx(INSET_SURFACE, 'space-y-3 p-4')}>
          <h3 className="text-base font-semibold text-fg">{t.settings.data.fileTitle}</h3>
          <p className="text-sm text-fg-muted">{t.settings.data.fileHint}</p>
          <Button
            icon={Upload}
            loading={busy === 'import'}
            disabled={busy !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy === 'import' ? t.settings.data.importing : t.settings.data.chooseFile}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".html,.htm,.json"
            onChange={(e) => void handleFile(e)}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="bookmark-file-input"
          />
        </div>
      </div>

      {lastImport && lastImport.added > 0 && (
        <div
          className={cx(
            'flex flex-wrap items-center gap-3 rounded-md border p-4',
            TONE_PANEL.accent,
          )}
        >
          <Sparkles size={18} aria-hidden className="shrink-0 text-accent-text" />
          <p className="min-w-48 flex-1 text-base text-fg">
            {fmt(t.settings.data.enrichInvite, { count: lastImport.added })}
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setLastImport(null);
              void startEnrichmentConfirmed();
            }}
          >
            {t.settings.data.enrichStart}
          </Button>
        </div>
      )}

      {profiles && profiles.length === 0 && (
        <div className="flex flex-wrap items-start gap-3 rounded-md border border-line p-4">
          <SearchX size={18} aria-hidden className="mt-0.5 shrink-0 text-fg-muted" />
          <div className="min-w-48 flex-1 space-y-1">
            <p className="text-base text-fg">{t.settings.data.noProfiles}</p>
            <p className="text-sm text-fg-muted">{t.settings.data.noProfilesHint}</p>
          </div>
          <Button size="sm" icon={Upload} onClick={() => fileInputRef.current?.click()}>
            {t.settings.data.chooseFile}
          </Button>
        </div>
      )}

      {profiles && profiles.length > 0 && (
        <div className="space-y-4 rounded-md border border-line p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-fg">{t.settings.data.profilesTitle}</h3>
            <IconButton label={t.common.close} icon={X} onClick={() => setProfiles(null)} />
          </div>
          <fieldset className="max-h-72 space-y-3 overflow-y-auto">
            <legend className="sr-only">{t.settings.data.profilesTitle}</legend>
            {profiles.map((profile) => (
              <Checkbox
                key={profile.id}
                checked={selected.has(profile.id)}
                onChange={() => toggle(profile.id)}
                disabled={Boolean(profile.error)}
                label={`${BROWSER_LABELS[profile.browser]} · ${profile.profileName}`}
                description={
                  profile.error
                    ? t.settings.data.profileErrors[profile.error]
                    : fmt(t.settings.data.profileCount, { count: profile.bookmarkCount })
                }
              />
            ))}
          </fieldset>
          <div className="flex justify-end gap-2 border-t border-line-subtle pt-4">
            <Button onClick={() => setProfiles(null)}>{t.common.cancel}</Button>
            <Button
              variant="primary"
              loading={busy === 'import'}
              disabled={selected.size === 0 || busy !== null}
              onClick={() => void handleImportSelected()}
            >
              {fmt(t.settings.data.importSelected, { count: selected.size })}
            </Button>
          </div>
        </div>
      )}

      <details className="group rounded-md border border-line-subtle px-4 py-3">
        <summary className="cursor-pointer text-base font-medium text-fg-secondary">
          {t.settings.data.manualTitle}
        </summary>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { name: 'Chrome / Edge', steps: t.settings.data.stepsChromium },
            { name: 'Firefox', steps: t.settings.data.stepsFirefox },
            { name: 'Safari', steps: t.settings.data.stepsSafari },
          ].map((b) => (
            <div key={b.name}>
              <dt className="text-sm font-semibold text-fg">{b.name}</dt>
              <dd className="mt-0.5 text-sm text-fg-muted">{b.steps}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
};

const BackupSection: React.FC = () => {
  const { t, locale } = useTranslation();
  const pushToast = useAppStore((s) => s.pushToast);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const restoreLibrary = useAppStore((s) => s.restoreLibrary);
  const resourceCount = useAppStore((s) => s.resources.length);
  const [exporting, setExporting] = useState<null | 'json' | 'html'>(null);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState<{ backup: ParsedBackup; fileName: string } | null>(null);
  const [mode, setMode] = useState<RestoreMode>('merge');
  const backupInputRef = useRef<HTMLInputElement>(null);

  const runExport = async (format: 'json' | 'html') => {
    const state = useAppStore.getState();
    if (state.resources.length === 0) {
      pushToast(t.settings.data.exportEmpty, 'info');
      return;
    }
    const content =
      format === 'json'
        ? backupToJson({
            resources: state.resources,
            collections: state.collections,
            chats: state.chats,
          })
        : toNetscapeHtml(state.resources);
    const name = exportFileName(format);
    setExporting(format);
    try {
      const path = await exportLibrary(format, content, name);
      pushToast(fmt(t.settings.data.exported, { path }), 'success', {
        action: {
          label: t.settings.data.showInFolder,
          run: () =>
            void revealInFolder(path).catch((error: unknown) => reportError(error, 'reveal')),
        },
      });
    } catch (error) {
      if (errorKind(error) === 'desktopOnly') {
        downloadText(content, name, format === 'json' ? 'application/json' : 'text/html');
        pushToast(fmt(t.settings.data.downloaded, { name }), 'success');
      } else {
        reportError(error, 'export', { prefix: t.settings.data.exportFailed });
      }
    } finally {
      setExporting(null);
    }
  };

  const readBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setReading(true);
    try {
      const backup = parseBackup(await file.text());
      setPending({ backup, fileName: file.name });
      setMode('merge');
    } catch (error) {
      const message =
        error instanceof BackupError
          ? t.settings.data.backupErrors[error.code]
          : errorMessage(error);
      pushToast(`${t.settings.data.restoreFailed}: ${message}`, 'error');
    } finally {
      setReading(false);
    }
  };

  const confirmRestore = () => {
    if (!pending) return;
    const { backup } = pending;
    const replace = mode === 'replace';
    requestConfirm({
      title: replace ? t.settings.data.confirmReplaceTitle : t.settings.data.confirmMergeTitle,
      message: replace
        ? fmt(t.settings.data.confirmReplaceMessage, {
            current: resourceCount,
            count: backup.resources.length,
          })
        : fmt(t.settings.data.confirmMergeMessage, { count: backup.resources.length }),
      confirmLabel: replace ? t.settings.data.confirmReplaceLabel : t.settings.data.restore,
      danger: replace,
      onConfirm: () => {
        // The restored library would live only until the app closes.
        if (isLibraryWriteBlocked()) {
          pushToast(t.settings.data.importBlocked, 'error');
          return;
        }
        const outcome = restoreLibrary(backup, mode);
        setPending(null);
        pushToast(fmt(t.settings.data.restored, { ...outcome }), 'success');
      },
    });
  };

  const summary = pending
    ? [
        fmt(t.settings.data.backupResources, { count: pending.backup.resources.length }),
        fmt(t.settings.data.backupCollections, { count: pending.backup.collections.length }),
        fmt(t.settings.data.backupChats, { count: Object.keys(pending.backup.chats).length }),
      ].join(' · ')
    : '';

  return (
    <Card padding="lg" className="space-y-5">
      <SectionTitle description={t.settings.data.exportHint}>
        {t.settings.data.exportTitle}
      </SectionTitle>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[
          {
            format: 'json' as const,
            icon: FileJson,
            title: t.settings.data.exportJson,
            hint: t.settings.data.exportJsonHint,
          },
          {
            format: 'html' as const,
            icon: FileCode2,
            title: t.settings.data.exportHtml,
            hint: t.settings.data.exportHtmlHint,
          },
        ].map((item) => (
          <div key={item.format} className={cx(INSET_SURFACE, 'flex flex-col gap-3 p-4')}>
            <div className="flex items-center gap-2">
              <item.icon size={18} aria-hidden className="text-accent-text" />
              <h3 className="text-base font-semibold text-fg">{item.title}</h3>
            </div>
            <p className="flex-1 text-sm text-fg-muted">{item.hint}</p>
            <Button
              icon={Download}
              loading={exporting === item.format}
              disabled={exporting !== null}
              onClick={() => void runExport(item.format)}
              className="self-start"
            >
              {item.title}
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-3 border-t border-line-subtle pt-5">
        <h3 className="text-base font-semibold text-fg">{t.settings.data.restoreTitle}</h3>
        <p className="text-sm text-fg-muted">{t.settings.data.restoreHint}</p>
        <Button
          icon={ArchiveRestore}
          loading={reading}
          onClick={() => backupInputRef.current?.click()}
        >
          {reading ? t.settings.data.readingBackup : t.settings.data.chooseBackup}
        </Button>
        <input
          ref={backupInputRef}
          type="file"
          accept=".json,application/json"
          onChange={(e) => void readBackup(e)}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="backup-file-input"
        />

        {/* Always mounted, so the backup summary is announced once a file has been read. */}
        <p className="sr-only" aria-live="polite">
          {pending ? `${pending.fileName}: ${summary}` : ''}
        </p>
        {pending && (
          <div className="space-y-4 rounded-md border border-line bg-surface-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-fg">{pending.fileName}</p>
                <p className="text-sm text-fg-secondary">{summary}</p>
                {pending.backup.exportedAt && (
                  <p className="text-sm text-fg-muted">
                    {fmt(t.settings.data.backupCreated, {
                      date: formatDate(Date.parse(pending.backup.exportedAt), locale),
                    })}
                  </p>
                )}
              </div>
              <IconButton label={t.common.cancel} icon={X} onClick={() => setPending(null)} />
            </div>
            <div className="space-y-2">
              <SegmentedControl
                label={t.settings.data.restoreMode}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'merge', label: t.settings.data.modeMerge },
                  { value: 'replace', label: t.settings.data.modeReplace },
                ]}
              />
              <p className="text-sm text-fg-muted">
                {mode === 'merge' ? t.settings.data.modeMergeHint : t.settings.data.modeReplaceHint}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPending(null)}>{t.common.cancel}</Button>
              <Button variant={mode === 'replace' ? 'danger' : 'primary'} onClick={confirmRestore}>
                {t.settings.data.restore}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

const DataSourceTab: React.FC = () => (
  <div className="space-y-4">
    <ImportSection />
    <BackupSection />
  </div>
);

export default DataSourceTab;
