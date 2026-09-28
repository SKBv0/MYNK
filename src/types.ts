/** Domain model: nothing derivable is stored; dates are epoch ms or `null`. */
import type { AIProvider, CategoryId, HealthErrorKind, UiLanguage } from './services/ipcTypes';

export type { CategoryId };
export type Language = UiLanguage;

/** Only the accent color is stored; every derived value is computed at render time. */
export interface ThemeConfig {
  accent: string;
}

export type AiStatus = 'none' | 'pending' | 'ok' | 'insufficient' | 'failed';

export interface ResourceAi {
  status: AiStatus;
  analyzedAt: number | null;
  /** Real 0..1 confidence reported by the analyzer; `null` when unknown. */
  confidence: number | null;
  error?: string;
}

export interface ResourceMedia {
  /** Remote favicon URL; not rendered directly. */
  faviconUrl?: string;
  /** og:image / twitter:image URL; not rendered directly. */
  imageUrl?: string;
  /** Cached copy of `faviconUrl` in the snapshot directory. */
  faviconFile?: string;
  /** Cached copy of `imageUrl` in the snapshot directory. */
  imageFile?: string;
  /** Epoch ms of the last cache attempt for `faviconUrl`/`imageUrl`. */
  remoteCachedAt?: number;
  /** Captured screenshot file name. */
  snapshotFile?: string;
  /** User-uploaded file name. */
  uploadedFile?: string;
  /** The last health check found the page reachable but gated (bot wall or 401/403/429). */
  previewBlocked?: boolean;
  /** Screenshot capture hit a bot-verification wall. */
  challenge?: boolean;
}

/** A partial media update; an explicit `undefined` removes that field. */
export type MediaPatch = { [K in keyof ResourceMedia]?: ResourceMedia[K] | undefined };

export type HealthStatus = 'unknown' | 'alive' | 'protected' | 'dead';

/** Failure class a check reported; `'none'` is never stored. */
export type HealthFailureKind = Exclude<HealthErrorKind, 'none'>;

export interface ResourceHealth {
  status: HealthStatus;
  checkedAt: number | null;
  httpStatus?: number;
  /** Why the last conclusive check found the link dead. */
  errorKind?: HealthFailureKind;
}

export interface Resource {
  id: string;
  url: string;
  /** Canonical dedup key (`lib/url.ts#canonicalUrlKey`). Unique across the library. */
  urlKey: string;
  title: string;
  /** True once the user renamed the resource; AI analysis will not overwrite it. */
  titleEditedByUser?: boolean;
  description: string;
  /** True while the description is the AI's own text; a later analysis may rewrite it. */
  descriptionByAi?: boolean;
  categoryId: CategoryId;
  tags: string[];
  summary: string[];
  /** Folder path from the browser import. */
  folderPath: string[];
  createdAt: number;
  /** Last content edit; flags, previews and cached media leave it alone. */
  updatedAt: number;
  lastOpenedAt: number | null;
  isFavorite: boolean;
  ai: ResourceAi;
  media: ResourceMedia;
  health: ResourceHealth;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  pinnedIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** Resource ids referenced by `[#n]` citations (1-based) in an assistant answer. */
  sources?: string[];
  /** Assistant answer stopped by the user before it finished (the text is incomplete). */
  partial?: boolean;
  /** Token usage of a streamed assistant answer (cost indicator). */
  usage?: ChatMessageUsage;
}

/** Usage stored with an assistant answer; a USD estimate is derived at render time. */
export interface ChatMessageUsage {
  promptTokens: number;
  completionTokens: number;
  /** Cost reported by the provider (OpenRouter `usage.cost`). */
  costUsd?: number;
  provider: AIProvider;
  /** Model id of the answer (price lookup when `costUsd` is missing). */
  model?: string;
}

/** Chat thread key: a resource id or the global library chat. */
export type ChatKey = string;
export const GLOBAL_CHAT_KEY = 'global';

export type ToastType = 'error' | 'success' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  action?: { label: string; run: () => void };
}

export interface HealthMeta {
  hasRun: boolean;
  lastScanAt: number | null;
}

export type JobKind = 'enrich' | 'health' | 'preview';
export type JobState = 'running' | 'paused' | 'cancelled' | 'done';

export interface JobProgress {
  kind: JobKind;
  state: JobState;
  total: number;
  done: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
  /** Extra per-kind counters. */
  counters: Record<string, number>;
}

export type ModalId = 'addLink' | 'palette' | 'globalChat' | 'synthesis';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export type SettingsTabId = 'ai' | 'data' | 'agents' | 'advanced';

/** Why the app opened the AI settings tab on its own; picks the sentence shown there. */
export type AiSetupReason =
  'ollamaUnreachable' | 'modelMissing' | 'notChatModel' | 'keyring' | 'notConfigured';

export interface AiSetupNotice {
  reason: AiSetupReason;
  /** Model the reason names, when it names one. */
  model?: string;
  /** What the stopped run was analyzing: its record ids, or every record that needs analysis. */
  targets: string[] | 'all';
}
