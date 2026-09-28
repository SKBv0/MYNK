import React from 'react';
import { BrainCircuit, Sparkles, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { startEnrichmentConfirmed } from '../store/jobs/enrich';
import { deleteResourcesWithMedia } from '../store/jobs/preview';
import { fmt } from '../lib/text';
import { formatNumber } from '../lib/format';
import { Button, IconButton } from './ui';

const BatchActionDock: React.FC = () => {
  const { t, locale } = useTranslation();
  const count = useAppStore((s) => s.batchSelectedIds.length);
  const openModal = useAppStore((s) => s.openModal);
  const clearBatch = useAppStore((s) => s.clearBatch);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const pushToast = useAppStore((s) => s.pushToast);

  if (count === 0) return null;

  const analyze = () => void startEnrichmentConfirmed(useAppStore.getState().batchSelectedIds);

  const remove = () => {
    const ids = useAppStore.getState().batchSelectedIds;
    requestConfirm({
      title: t.batch.deleteTitle,
      message: fmt(t.batch.deleteMessage, { count: ids.length }),
      confirmLabel: t.common.delete,
      danger: true,
      onConfirm: () => {
        const removed = deleteResourcesWithMedia(ids);
        pushToast(fmt(t.batch.deleted, { count: removed.length }), 'success');
      },
    });
  };

  return (
    <div
      role="toolbar"
      aria-label={t.batch.toolbar}
      className="absolute bottom-6 left-1/2 z-dock flex -translate-x-1/2 animate-rise-in items-center gap-1 rounded-lg border border-line bg-surface-2 p-1.5 shadow-lg"
    >
      <span
        className="flex h-control-md items-center gap-2 px-3 text-base font-medium text-fg"
        aria-live="polite"
      >
        {/* Visual badge only; the sentence next to it is what gets announced. */}
        <span
          aria-hidden
          className="flex h-6 min-w-6 items-center justify-center rounded-sm bg-accent px-1.5 text-sm font-semibold tabular-nums text-accent-contrast"
        >
          {formatNumber(count, locale)}
        </span>
        <span className="sr-only">{fmt(t.batch.selected, { count })}</span>
      </span>
      <span aria-hidden className="mx-1 h-6 w-px bg-line" />
      <Button variant="ghost" icon={BrainCircuit} onClick={() => openModal('synthesis')}>
        {t.batch.synthesize}
      </Button>
      <Button variant="ghost" icon={Sparkles} onClick={analyze}>
        {t.batch.analyze}
      </Button>
      <Button
        variant="ghost"
        icon={Trash2}
        onClick={remove}
        className="text-danger hover:text-danger"
      >
        {t.common.delete}
      </Button>
      <span aria-hidden className="mx-1 h-6 w-px bg-line" />
      <IconButton label={t.batch.clear} icon={X} onClick={clearBatch} />
    </div>
  );
};

export default BatchActionDock;
