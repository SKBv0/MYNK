import React, { useMemo, useRef, useState } from 'react';
import { BrainCircuit, Copy, MousePointerClick, RotateCcw, Sparkles, Square } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { getT, useAppStore } from '../store';
import { useChatStream, type ChatStreamOutcome } from '../hooks/useChatStream';
import {
  buildSynthesisRequest,
  toSynthesisItem,
  withSourceList,
  type SynthesisSource,
} from '../lib/synthesis';
import StreamingCursor from './chat/StreamingCursor';
import { useTranslation } from '../hooks/useTranslation';
import { useReportFlag } from '../hooks/useReportFlag';
import { useGuardedClose } from '../hooks/useGuardedClose';
import SmartImage from './SmartImage';
import MarkdownRenderer from './MarkdownRenderer';
import { resourcePreviews } from '../lib/media';
import { copyToClipboard, reportError } from '../lib/errors';
import { modifierKeyLabel } from '../lib/platform';
import { fmt } from '../lib/text';
import { Button, EmptyState, INSET_SURFACE, Modal, Spinner, cx } from './ui';

interface SynthesisResult {
  text: string;
  /** Stopped by the user: the report is incomplete. */
  partial: boolean;
  /** The bookmarks behind `[#n]` citations, in prompt order. */
  sources: SynthesisSource[];
}

/**
 * Bookmarks one report reads. Each one adds up to ~1.3k prompt characters plus its URL; Rust
 * rejects prompts above 200k (`commands::ai::MAX_PROMPT_CHARS`) and small models lose far less.
 */
export const MAX_SYNTHESIS_ITEMS = 50;

/** Synthesis of the batch-selected bookmarks (single dialog instance). */
const SynthesisMode: React.FC = () => {
  const isOpen = useAppStore((s) => s.activeModal === 'synthesis');
  const closeModal = useAppStore((s) => s.closeModal);
  const { t } = useTranslation();
  const streamingRef = useRef(false);
  const close = useGuardedClose(() => streamingRef.current, closeModal);

  return (
    <Modal
      open={isOpen}
      onClose={close}
      title={t.synthesis.title}
      icon={
        <span
          aria-hidden
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text"
        >
          <BrainCircuit size={18} />
        </span>
      }
      size="xl"
    >
      <SynthesisBody
        onClose={closeModal}
        onStreamingChange={(streaming) => {
          streamingRef.current = streaming;
        }}
      />
    </Modal>
  );
};

const SynthesisBody: React.FC<{
  onClose: () => void;
  onStreamingChange: (streaming: boolean) => void;
}> = ({ onClose, onStreamingChange }) => {
  const { t, lang } = useTranslation();
  const selected = useAppStore(
    useShallow((s) => {
      const ids = new Set(s.batchSelectedIds);
      return s.resources.filter((r) => ids.has(r.id));
    }),
  );
  const used = useMemo(() => selected.slice(0, MAX_SYNTHESIS_ITEMS), [selected]);
  const mediaReady = useAppStore((s) => s.mediaReady);
  const selectResource = useAppStore((s) => s.selectResource);
  const [result, setResult] = useState<SynthesisResult | null>(null);
  const stream = useChatStream();
  const { send, reset, cancel } = stream;

  useReportFlag(onStreamingChange, stream.streaming);

  const thumbs = useMemo(
    () =>
      selected
        .slice(0, 6)
        .map((r) => ({ id: r.id, title: r.title, sources: resourcePreviews(r, mediaReady) })),
    [selected, mediaReady],
  );

  const run = () => {
    if (selected.length === 0 || stream.streaming) return;
    setResult(null);
    const sources = used.map(({ id, title, url }) => ({ id, title, url }));
    const onSettled = (outcome: ChatStreamOutcome) => {
      if (outcome.error) {
        reportError(outcome.error, 'synthesis', { prefix: getT().synthesis.failed });
      } else if (outcome.text.trim()) {
        setResult({ text: outcome.text, partial: outcome.cancelled, sources });
      }
      reset();
    };
    void send(buildSynthesisRequest(used.map(toSynthesisItem), lang), { onSettled });
  };

  if (selected.length === 0) {
    return (
      <EmptyState
        icon={MousePointerClick}
        title={t.synthesis.heading}
        description={fmt(t.synthesis.emptySelection, { mod: modifierKeyLabel() })}
        actions={<Button onClick={onClose}>{t.common.close}</Button>}
        size="compact"
        headingLevel="h3"
      />
    );
  }

  if (stream.streaming && !stream.text) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3" role="status">
        <Spinner size={28} className="text-accent-text" />
        <p className="text-base text-fg-secondary">
          {fmt(t.synthesis.loading, { count: used.length })}
        </p>
        <Button icon={Square} onClick={() => void cancel()}>
          {t.synthesis.stop}
        </Button>
      </div>
    );
  }

  if (stream.streaming) {
    return (
      <div className="space-y-4">
        <div className={cx(INSET_SURFACE, 'p-5')}>
          <MarkdownRenderer text={stream.text} trailing={<StreamingCursor />} />
          <span className="sr-only" role="status">
            {t.synthesis.writing}
          </span>
        </div>
        <div className="flex justify-end">
          <Button icon={Square} onClick={() => void cancel()}>
            {t.synthesis.stop}
          </Button>
        </div>
      </div>
    );
  }

  if (result === null) {
    return (
      <div className="flex flex-col items-center gap-6 py-8 text-center">
        <ul
          className="flex -space-x-3"
          aria-label={fmt(t.synthesis.description, { count: selected.length })}
        >
          {thumbs.map((thumb) => (
            <li
              key={thumb.id}
              className="h-14 w-14 overflow-hidden rounded-md border-2 border-surface-1 bg-surface-2"
            >
              <SmartImage
                sources={thumb.sources}
                className="h-full w-full object-cover"
                alt={thumb.title}
                loading="lazy"
              />
            </li>
          ))}
        </ul>
        <div className="max-w-md space-y-2">
          <h3 className="text-lg font-semibold text-fg">{t.synthesis.heading}</h3>
          <p className="text-base text-fg-muted">
            {fmt(t.synthesis.description, { count: selected.length })}
          </p>
          {selected.length > used.length && (
            <p className="text-sm text-fg-muted">
              {fmt(t.synthesis.limited, { count: selected.length, limit: used.length })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={onClose}>{t.common.close}</Button>
          <Button variant="primary" icon={Sparkles} onClick={run}>
            {t.synthesis.run}
          </Button>
        </div>
      </div>
    );
  }

  const openCitation = (index: number) => {
    const id = result.sources[index - 1]?.id;
    if (!id) return;
    onClose();
    selectResource(id);
  };

  return (
    <div className="space-y-4">
      <div className={cx(INSET_SURFACE, 'p-5')}>
        <MarkdownRenderer text={result.text} onCitation={openCitation} />
        {result.partial && (
          <p className="mt-3 text-sm italic text-fg-muted">{t.synthesis.stopped}</p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button icon={RotateCcw} onClick={run}>
          {t.synthesis.rerun}
        </Button>
        <Button
          variant="primary"
          icon={Copy}
          onClick={() =>
            void copyToClipboard(
              withSourceList(result.text, result.sources, t.synthesis.sources),
              t.synthesis.copied,
            )
          }
        >
          {t.synthesis.copy}
        </Button>
      </div>
    </div>
  );
};

export default SynthesisMode;
