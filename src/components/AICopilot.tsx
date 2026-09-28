import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatMessage, ChatMessageUsage, Resource } from '../types';
import { GLOBAL_CHAT_KEY } from '../types';
import { getAiSettings } from '../services/aiService';
import type { AISettings, ChatUsage } from '../services/ipcTypes';
import { useChatStream, type ChatStreamOutcome } from '../hooks/useChatStream';
import { getT, useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { useReportFlag } from '../hooks/useReportFlag';
import { useLatest } from '../hooks/useLatest';
import MarkdownRenderer from './MarkdownRenderer';
import ChatUsageLine from './chat/ChatUsageLine';
import StreamingCursor from './chat/StreamingCursor';
import { newId } from '../lib/id';
import { errorMessage, reportError } from '../lib/errors';
import {
  buildGlobalSystemPrompt,
  buildResourceSystemPrompt,
  historyTurns,
  selectContextResources,
} from '../lib/chatContext';
import { Badge, Button, INSET_SURFACE, IconButton, Spinner, cx } from './ui';
import { FIELD_SURFACE } from './ui/styles';
import { fmt } from '../lib/text';

interface AICopilotProps {
  /** Resource chat when set; the global library chat otherwise. */
  contextResource?: Resource | null;
  /** Called when a `[#n]` citation of the global chat is clicked. */
  onOpenResource?: (id: string) => void;
  /** Shows a close button in the header (dialog use). */
  onClose?: () => void;
  /** Reports whether a question is being answered (a dialog asks before closing over it). */
  onBusyChange?: (busy: boolean) => void;
  /** `sheet`: pinned to the bottom of a panel, the thread folds away until it has messages. */
  variant?: 'panel' | 'sheet';
}

/** Stable empty list so the selector does not create a new array on every render. */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** Within this distance of the end the thread counts as "at the bottom" and keeps following. */
const FOLLOW_THRESHOLD_PX = 48;

const toMessageUsage = (
  usage: ChatUsage | null,
  settings: AISettings | null,
): ChatMessageUsage | undefined => {
  if (!usage || !settings) return undefined;
  const model = settings.provider === 'ollama' ? settings.ollamaModel : settings.openrouterModel;
  const result: ChatMessageUsage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    provider: settings.provider,
  };
  if (usage.costUsd !== undefined) result.costUsd = usage.costUsd;
  if (model) result.model = model;
  return result;
};

/** Provider settings for the usage line; the chat itself works without them. */
const loadSettings = (): Promise<AISettings | null> => getAiSettings().catch(() => null);

const AICopilot: React.FC<AICopilotProps> = ({
  contextResource = null,
  onOpenResource,
  onClose,
  onBusyChange,
  variant = 'panel',
}) => {
  const { t, lang } = useTranslation();
  const chatKey = contextResource?.id ?? GLOBAL_CHAT_KEY;
  const messages = useAppStore((s) => s.chats[chatKey] ?? EMPTY_MESSAGES);
  const appendChatMessage = useAppStore((s) => s.appendChatMessage);
  const clearChat = useAppStore((s) => s.clearChat);
  const [input, setInput] = useState('');
  // True from "send" until the answer is stored (covers the settings lookup before streaming).
  const [isBusy, setIsBusy] = useState(false);
  const busyRef = useLatest(isBusy);
  /** The last failed question's error and retry, shown in the thread where the answer would be. */
  const [retryFailed, setRetryFailed] = useState<{ message: string; retry: () => void } | null>(
    null,
  );
  // Sheet: the thread opens on the first question and can be folded away; the box always shows.
  const [threadOpen, setThreadOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** False once the user scrolls up to read; true again at the end of the thread or on send. */
  const followRef = useRef(true);
  const stream = useChatStream();
  const { send: sendStream, reset: resetStream, cancel: cancelStream } = stream;
  const liveLength = stream.text.length;
  const hasLiveText = liveLength > 0;

  // Follows the stream only while the reader is at the end, and jumps: smooth would lag behind.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: liveLength > 0 ? 'auto' : 'smooth' });
  }, [messages.length, isBusy, liveLength]);

  // The question box grows with its content up to its max height, then scrolls.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useReportFlag(onBusyChange, isBusy);

  const ask = useCallback(
    async (prompt: string, appendUser: boolean) => {
      const state = useAppStore.getState();
      const thread = state.chats[chatKey] ?? EMPTY_MESSAGES;
      // History excludes the prompt itself (it is sent as `prompt`).
      const history = historyTurns(appendUser ? thread : thread.slice(0, -1));
      let promptId = thread[thread.length - 1]?.id;
      if (appendUser) {
        promptId = newId();
        appendChatMessage(chatKey, {
          id: promptId,
          role: 'user',
          content: prompt,
          createdAt: Date.now(),
        });
      }

      const labels = getT().categories;
      let system: string;
      let sources: string[] | undefined;
      if (contextResource) {
        system = buildResourceSystemPrompt(contextResource, labels[contextResource.categoryId]);
      } else {
        const { items, matched } = selectContextResources(state.resources, prompt);
        sources = items.map((r) => r.id);
        system = buildGlobalSystemPrompt(
          items,
          state.resources.length,
          matched,
          (r) => labels[r.categoryId],
        );
      }

      setIsBusy(true);
      setRetryFailed(null);
      const settings = await loadSettings();

      const retry = () => {
        // The toast outlives the answer; retrying under a newer question would cancel it.
        if (busyRef.current) return;
        const current = useAppStore.getState().chats[chatKey] ?? EMPTY_MESSAGES;
        // Asked again below anything newer, so the answer never lands without its question.
        void ask(prompt, current[current.length - 1]?.id !== promptId);
      };

      const onSettled = (outcome: ChatStreamOutcome) => {
        if (outcome.error) {
          // A toast disappears; the thread keeps saying why this question got no answer.
          setRetryFailed({ message: errorMessage(outcome.error), retry });
          reportError(outcome.error, 'chat', {
            prefix: getT().chat.failed,
            action: { label: getT().common.retry, run: retry },
          });
        } else if (outcome.text.trim()) {
          // Finished answers and user-stopped partial answers are both kept.
          const message: ChatMessage = {
            id: newId(),
            role: 'assistant',
            content: outcome.text,
            createdAt: Date.now(),
          };
          if (sources && sources.length > 0) message.sources = sources;
          if (outcome.cancelled) message.partial = true;
          const usage = toMessageUsage(outcome.usage, settings);
          if (usage) message.usage = usage;
          appendChatMessage(chatKey, message);
        }
        // The stored message replaces the live bubble in the same render.
        resetStream();
        setIsBusy(false);
      };

      await sendStream({ prompt, history, lang, system }, { onSettled });
    },
    [appendChatMessage, busyRef, chatKey, contextResource, lang, resetStream, sendStream],
  );

  const handleSend = () => {
    const prompt = input.trim();
    if (!prompt || isBusy) return;
    followRef.current = true;
    setThreadOpen(true);
    setInput('');
    void ask(prompt, true);
  };

  const openCitation = (message: ChatMessage, index: number) => {
    const id = message.sources?.[index - 1];
    if (id && onOpenResource) onOpenResource(id);
  };

  const isResourceChat = Boolean(contextResource);
  const placeholder = isResourceChat ? t.chat.resourcePlaceholder : t.chat.globalPlaceholder;
  const isSheet = variant === 'sheet';
  const hasThread = messages.length > 0 || isBusy;
  const showThread = !isSheet || (hasThread && threadOpen);

  return (
    <div className={cx('flex min-h-0 w-full flex-col', isSheet ? 'min-h-0' : 'h-full')}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-subtle px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text"
          >
            <MessageSquareText size={16} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-fg">
              {isResourceChat ? t.chat.resourceTitle : t.chat.globalTitle}
            </h3>
            <p className="truncate text-sm text-fg-muted">
              {isResourceChat ? t.chat.resourceContext : t.chat.globalContext}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isSheet && hasThread && (
            <>
              <Badge>{fmt(t.chat.messageCount, { count: messages.length })}</Badge>
              <IconButton
                label={threadOpen ? t.chat.collapse : t.chat.expand}
                icon={threadOpen ? ChevronDown : ChevronUp}
                pressed={threadOpen}
                onClick={() => setThreadOpen((open) => !open)}
              />
            </>
          )}
          {messages.length > 0 && (
            <IconButton
              label={t.chat.clear}
              icon={Trash2}
              disabled={isBusy}
              onClick={() => {
                clearChat(chatKey);
                setRetryFailed(null);
              }}
            />
          )}
          {onClose && <IconButton label={t.common.close} icon={X} onClick={onClose} />}
        </div>
      </div>

      {showThread && (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            followRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
          }}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5"
          // No `aria-live`: it would re-announce the thread per chunk; `role="status"` does it below.
          aria-busy={isBusy}
        >
          {!isSheet && messages.length === 0 && !isBusy && (
            <div className="flex h-full flex-col items-center justify-center py-6 text-center">
              <span
                aria-hidden
                className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-line bg-surface-2 text-accent-text"
              >
                <Sparkles size={18} />
              </span>
              <p className="text-base font-semibold text-fg">
                {isResourceChat ? t.chat.resourceEmptyTitle : t.chat.globalEmptyTitle}
              </p>
              <p className="mt-1 max-w-xs text-sm text-fg-muted">
                {isResourceChat ? t.chat.resourceEmptyHint : t.chat.globalEmptyHint}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cx(
                'flex flex-col gap-1.5',
                msg.role === 'assistant' ? 'items-start' : 'items-end',
              )}
            >
              <span className="text-xs font-medium text-fg-muted">
                {msg.role === 'assistant' ? t.chat.assistant : t.chat.you}
              </span>
              {msg.role === 'assistant' ? (
                <>
                  <div className={cx(INSET_SURFACE, 'w-full px-4 py-3')}>
                    <MarkdownRenderer
                      text={msg.content}
                      onCitation={
                        msg.sources && onOpenResource
                          ? (index) => openCitation(msg, index)
                          : undefined
                      }
                    />
                    {msg.partial && (
                      <p className="mt-2 text-sm italic text-fg-muted">{t.chat.stopped}</p>
                    )}
                  </div>
                  {msg.usage && <ChatUsageLine usage={msg.usage} />}
                </>
              ) : (
                <div className="ml-10 whitespace-pre-wrap rounded-md bg-accent-soft px-4 py-2.5 text-base text-fg">
                  {msg.content}
                </div>
              )}
            </div>
          ))}

          {isBusy && hasLiveText && (
            <div className="flex flex-col items-start gap-1.5">
              <span className="text-xs font-medium text-fg-muted">{t.chat.assistant}</span>
              <div className={cx(INSET_SURFACE, 'w-full px-4 py-3')}>
                <MarkdownRenderer
                  text={stream.text}
                  trailing={stream.streaming ? <StreamingCursor /> : null}
                />
              </div>
              <span className="sr-only" role="status">
                {t.chat.streaming}
              </span>
            </div>
          )}

          {isBusy && !hasLiveText && (
            <div className="flex items-center gap-2 text-sm text-fg-muted" role="status">
              <Spinner size={14} className="text-accent-text" />
              {isResourceChat ? t.chat.thinkingResource : t.chat.thinkingGlobal}
            </div>
          )}

          {retryFailed && !isBusy && (
            <div className="flex flex-wrap items-center justify-end gap-3" role="alert">
              <p className="text-sm text-danger">
                {t.chat.failed}: {retryFailed.message}
              </p>
              <Button size="sm" variant="dangerSoft" icon={RotateCcw} onClick={retryFailed.retry}>
                {t.chat.retry}
              </Button>
            </div>
          )}
        </div>
      )}

      <form
        className="shrink-0 border-t border-line-subtle p-4"
        onSubmit={(event) => {
          event.preventDefault();
          handleSend();
        }}
      >
        {/* `FIELD_BORDER` is not used: the box has no hover border of its own. */}
        <div className={cx(FIELD_SURFACE, 'flex items-end gap-2 border-line p-1.5')}>
          <textarea
            ref={textareaRef}
            spellCheck={false}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              } else if (e.key === 'Escape' && input.trim()) {
                // Escape leaves the box first; a half-typed question survives, the next press closes.
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            className="field-control max-h-36 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-base text-fg placeholder:text-fg-muted"
          />
          {isBusy ? (
            <IconButton
              label={t.chat.stop}
              icon={Square}
              variant="primary"
              disabled={!stream.streaming}
              onClick={() => void cancelStream()}
            />
          ) : (
            <IconButton
              type="submit"
              label={t.chat.send}
              icon={Send}
              variant="primary"
              disabled={!input.trim()}
            />
          )}
        </div>
      </form>
    </div>
  );
};

export default AICopilot;
