/** AI / provider IPC wrappers. Thin layer over `call()`; errors are thrown as `IpcError`. */
import { Channel } from '@tauri-apps/api/core';
import { call, IpcError, isDesktopRuntime, desktopOnlyError, toIpcError } from './ipc';
import type {
  AISettings,
  AISettingsUpdate,
  AnalyzeResult,
  CategoryId,
  ChatRequest,
  ChatStreamEvent,
  ModelInfo,
  ProviderConnectionResult,
  UiLanguage,
} from './ipcTypes';
import { DATA_FENCE, DATA_FENCE_END, UNTRUSTED_RULE, promptField } from '../lib/promptSafety';
import { parseHttpUrl } from '../lib/url';
import { newId } from '../lib/id';
import { translations } from '../translations';

export interface SynthesisItem {
  title: string;
  description: string;
  categoryId: CategoryId;
  tags: string[];
  summary: string[];
  url: string;
}

// Hung-channel guards above the Rust budgets: analysis 300 s, chat up to three 120 s requests.
const ANALYZE_TIMEOUT_MS = 320_000;
const CHAT_TIMEOUT_MS = 400_000;
const TEST_TIMEOUT_MS = 140_000;
const MODELS_TIMEOUT_MS = 30_000;
const STREAM_END_GRACE_MS = 5_000;

export const getAiSettings = (): Promise<AISettings> => call<AISettings>('get_ai_settings');

export const updateAiSettings = (payload: AISettingsUpdate): Promise<AISettings> =>
  call<AISettings>('update_ai_settings', { payload });

export const setOpenRouterApiKey = (apiKey: string): Promise<void> =>
  call<void>('set_openrouter_api_key', { apiKey });

export const clearOpenRouterApiKey = (): Promise<void> => call<void>('clear_openrouter_api_key');

/** Lists the models an Ollama host serves; `allowPrivateNetwork` defaults to the stored setting. */
export const listOllamaModels = (
  baseUrl?: string,
  allowPrivateNetwork?: boolean,
): Promise<ModelInfo[]> => {
  const trimmed = baseUrl?.trim();
  const args: Record<string, unknown> = {};
  if (trimmed) args.baseUrl = trimmed;
  if (allowPrivateNetwork !== undefined) args.allowPrivateNetwork = allowPrivateNetwork;
  return call<ModelInfo[]>('list_ollama_models', args, { timeoutMs: MODELS_TIMEOUT_MS });
};

export const listOpenRouterModels = (): Promise<ModelInfo[]> =>
  call<ModelInfo[]>('list_openrouter_models', undefined, { timeoutMs: MODELS_TIMEOUT_MS });

/** Runs a real, tiny completion against the candidate settings (not saved). */
export const testProviderConnection = (
  payload: AISettingsUpdate,
): Promise<ProviderConnectionResult> =>
  call<ProviderConnectionResult>(
    'test_provider_connection',
    { payload },
    { timeoutMs: TEST_TIMEOUT_MS },
  );

/** Analyzes a URL; with `requestId` it's cancellable via `cancelRequest`. */
export const analyzeUrl = (
  url: string,
  lang: UiLanguage,
  requestId?: string,
): Promise<AnalyzeResult> =>
  call<AnalyzeResult>('analyze_url', requestId ? { url, lang, requestId } : { url, lang }, {
    timeoutMs: ANALYZE_TIMEOUT_MS,
  });

/** Non-streaming chat. Optional `requestId` makes it cancellable via `cancelRequest`. */
export const chat = (request: ChatRequest, requestId?: string): Promise<string> =>
  call<string>('chat_complete', requestId ? { request, requestId } : { request }, {
    timeoutMs: CHAT_TIMEOUT_MS,
  });

/** Cancels an in-flight `chatStream` / `analyzeUrl` / `chat` request. Unknown ids are ignored. */
export const cancelRequest = (requestId: string): Promise<void> =>
  call<void>('cancel_request', { requestId });

export interface ChatStreamHandle {
  requestId: string;
  /** Cancels the stream; `done` then rejects with `IpcError('cancelled')`. */
  cancel: () => Promise<void>;
  /** Resolves with the full answer text; rejects with `IpcError` (incl. `cancelled`). */
  done: Promise<string>;
}

/** Streaming chat over a Tauri `Channel`; `onEvent` gets every `delta`/`done`/`error` in order. */
export const chatStream = (
  request: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
): ChatStreamHandle => {
  const requestId = newId();
  if (!isDesktopRuntime()) {
    const done = Promise.reject(desktopOnlyError());
    done.catch(() => undefined);
    return { requestId, cancel: () => Promise.resolve(), done };
  }

  let settled = false;
  let text = '';
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone!: (value: string) => void;
  let rejectDone!: (error: IpcError) => void;
  const done = new Promise<string>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (error?: IpcError) => {
    if (settled) return;
    settled = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (error) rejectDone(error);
    else resolveDone(text);
  };

  const channel = new Channel<ChatStreamEvent>();
  channel.onmessage = (event) => {
    if (settled) return;
    if (event.type === 'delta') text += event.text;
    onEvent(event);
    if (event.type === 'done') finish();
    else if (event.type === 'error') finish(toIpcError(event.error));
  };

  // A rejection means the stream never started and no final event will arrive.
  call<void>('chat_stream', { request, requestId, channel }).then(
    () => {
      if (!settled) {
        // Channel messages and the command response travel separately; give it a grace period.
        graceTimer = setTimeout(
          () =>
            finish(
              new IpcError('internal', 'The chat stream ended without a result.').withDetail({
                key: 'streamNoResult',
              }),
            ),
          STREAM_END_GRACE_MS,
        );
      }
    },
    (error: unknown) => {
      const ipcError = toIpcError(error);
      onEvent({ type: 'error', error: { kind: ipcError.kind, message: ipcError.message } });
      finish(ipcError);
    },
  );

  // Callers usually await `done`; this only keeps an ignored rejection from being "unhandled".
  done.catch(() => undefined);

  return {
    requestId,
    cancel: async () => {
      if (settled) return;
      await cancelRequest(requestId);
    },
    done,
  };
};

const stripCodeFence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
};

/** Extracts a keyword list from a JSON-mode response. Exported for tests. */
export const parseKeywordResponse = (raw: string): string[] => {
  const text = stripCodeFence(raw);
  const start = text.search(/[[{]/);
  if (start < 0) {
    throw new IpcError('parse', 'Keyword suggestion response was not JSON.').withDetail({
      key: 'keywordsNotJson',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new IpcError('parse', 'Keyword suggestion response was not valid JSON.').withDetail({
        key: 'keywordsInvalidJson',
      });
    }
  }

  let list: unknown = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    list = obj.keywords ?? obj.tags ?? Object.values(obj).find(Array.isArray);
  }
  if (typeof list === 'string') {
    list = list.split(',');
  }
  if (!Array.isArray(list)) {
    throw new IpcError(
      'parse',
      'Keyword suggestion response did not contain a keyword list.',
    ).withDetail({ key: 'keywordsNoList' });
  }

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const keyword = item.trim().toLowerCase().slice(0, 40);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= 8) break;
  }
  return keywords;
};

export const suggestKeywords = async (
  name: string,
  description: string,
  lang: UiLanguage,
): Promise<string[]> => {
  const prompt = [
    'Suggest 5-8 short search keywords for a bookmark collection.',
    `Collection name: ${JSON.stringify(name)}`,
    `Collection description: ${JSON.stringify(description)}`,
    'Return ONLY a JSON object of the form {"keywords": ["...", "..."]}.',
  ].join('\n');

  const response = await chat({
    prompt,
    history: [],
    lang,
    jsonMode: true,
    system: 'You generate concise search keywords for a personal knowledge base. Output JSON only.',
  });
  return parseKeywordResponse(response);
};

const synthesisSystemPrompt = (
  lang: UiLanguage,
): string => `You write one report from a set of the user's bookmarks.
Use only the bookmark data between the fences; never invent sources or facts.
${UNTRUSTED_RULE}
Write in plain, direct language. No filler and no buzzwords.
Do not summarize the bookmarks one by one; group what they share and where they differ.
After each claim, cite the bookmark it comes from with its number, e.g. [#2].
Write about the topic itself. Do not mention "the provided bookmarks" or these instructions.
Write the title and every heading in the same language as the report.

Format, in Markdown, in this order:
1. A title on the first line, as "# Title".
2. One short paragraph on what these bookmarks cover together.
3. Sections by theme, as "## Theme", with bullet points for the key facts.
4. A final "## ${translations[lang].synthesis.conclusion}" of two or three sentences.`;

/** Builds the synthesis chat request; sent through `chatStream` by the synthesis dialog. */
export const buildSynthesisRequest = (items: SynthesisItem[], lang: UiLanguage): ChatRequest => {
  const field = promptField;
  const context = items
    .map((item, index) =>
      [
        `[#${index + 1}] ${field(item.title, 140)}`,
        `url: ${item.url}`,
        `category: ${item.categoryId}`,
        `tags: ${field(item.tags.join(', '), 200)}`,
        `description: ${field(item.description, 280)}`,
        `key points: ${field(item.summary.join(' '), 600)}`,
      ].join('\n'),
    )
    .join('\n\n');

  return {
    prompt: `Synthesize these ${items.length} bookmarks:\n${DATA_FENCE}\n${context}\n${DATA_FENCE_END}`,
    history: [],
    lang,
    system: synthesisSystemPrompt(lang),
  };
};

const normalizeExternalUrl = (value: string): string => {
  if (!value.trim()) {
    throw new IpcError('invalidInput', 'URL is empty.');
  }
  const parsed = parseHttpUrl(value);
  if (!parsed) {
    throw new IpcError('invalidInput', 'Only valid http/https URLs can be opened.');
  }
  return parsed.toString();
};

/** Opens an http/https URL in the system browser. No window.open fallback. */
export const openExternalUrl = async (url: string): Promise<void> => {
  await call<void>('open_external_url', { url: normalizeExternalUrl(url) });
};
