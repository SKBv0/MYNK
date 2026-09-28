/**
 * Types that cross the `invoke()` boundary between the React renderer and the Rust backend.
 * Rust structs use camelCase serde renaming.
 */

export type AIProvider = 'ollama' | 'openrouter';
export type UiLanguage = 'en' | 'tr';

/** Stable, language-independent category ids. Display names come from i18n. */
export const CATEGORY_IDS = [
  'development',
  'design',
  'research',
  'business',
  'news',
  'learning',
  'tools',
  'entertainment',
  'finance',
  'health',
  'shopping',
  'travel',
  'reference',
  'social',
  'other',
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export type AppErrorKind =
  | 'desktopOnly' // renderer is not running inside Tauri
  | 'config' // AI provider not configured / invalid provider settings
  | 'invalidInput' // a value the user typed or the renderer sent is not valid
  | 'network' // DNS, connection refused, TLS
  | 'timeout'
  | 'blockedAddress' // SSRF guard rejected a private/loopback target
  | 'provider' // LLM provider returned an error status
  | 'parse' // could not parse provider / page output
  | 'keyring'
  | 'storage'
  | 'notFound'
  | 'cancelled'
  | 'internal';

/** Machine-readable refinement of a `config`, `network` or `storage` error (`errors.codes`). */
export type AppErrorCode =
  | 'modelMissing'
  | 'notChatModel'
  | 'ollamaUnreachable'
  | 'hostNotFound'
  | 'tlsCertificate'
  | 'tlsHandshake'
  | 'browserLocked'
  | 'inputTooLong';

/** Result of `library_load`. */
export interface LibraryLoadResult {
  /** Library JSON; `null` when no library file exists yet. */
  json: string | null;
  /** True when the main file was missing or corrupt and its `.bak` was read instead. */
  recoveredFromBackup: boolean;
}

/** Shape of every rejected `invoke()` promise. */
export interface AppErrorPayload {
  kind: AppErrorKind;
  message: string;
  /** HTTP status for `provider` / `network` errors when available. */
  status?: number;
  /** Refines `kind` with a specific, translatable cause (see `AppErrorCode`). */
  code?: AppErrorCode;
  /** Model the `code` is about, when it names one. */
  model?: string;
}

export interface AISettings {
  provider: AIProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openrouterModel: string;
  hasOpenrouterApiKey: boolean;
  /** Allow requests to private-network hosts (LAN Ollama etc.). Default false. */
  allowPrivateNetwork: boolean;
  /** Ollama embedding model for the agent bridge's semantic search; empty lets the server's list decide. */
  embeddingModel: string;
}

export interface AISettingsUpdate {
  provider: AIProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openrouterModel: string;
  allowPrivateNetwork: boolean;
  embeddingModel: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  sizeBytes?: number;
  contextLength?: number;
  /** USD per million prompt tokens (OpenRouter pricing), when known. */
  promptPricePerMTok?: number;
  /** USD per million completion tokens (OpenRouter pricing), when known. */
  completionPricePerMTok?: number;
  /** True for an Ollama embedding model: it cannot be used for chat or analysis. */
  embedding?: boolean;
}

/** Why a connection test failed; the UI shows a translated sentence for it. */
export type ProviderConnectionFailure =
  | 'unreachable'
  | 'timeout'
  | 'blockedAddress'
  | 'modelMissing'
  | 'notChatModel'
  | 'unauthorized'
  | 'invalidSettings'
  | 'other';

export interface ProviderConnectionResult {
  ok: boolean;
  /** English developer text; never shown to the user (see `reason`). */
  message: string;
  latencyMs?: number;
  /** Set when `ok` is false. */
  reason?: ProviderConnectionFailure;
}

/** Where the analyzed title, description and text came from. */
export type AnalyzeSource = 'http' | 'browser';

export interface AnalyzeResult {
  title: string;
  description: string;
  categoryId: CategoryId;
  tags: string[];
  summary: string[];
  /** True when the page had too little readable text; fields are metadata-only. */
  insufficientContent: boolean;
  /** 0..1, derived from grounding + amount of readable text + fetch success. */
  confidence: number;
  /** Absolute favicon URL discovered from <link rel=icon> or /favicon.ico. */
  faviconUrl?: string;
  /** og:image / twitter:image URL if the page declares one. */
  imageUrl?: string;
  /** Final URL after redirects. */
  finalUrl: string;
  /** `browser` when the HTTP fetch was unusable and the rendered DOM was analyzed instead. */
  source?: AnalyzeSource;
  /**
   * The AI provider could not be used after the page was read. The metadata fields are real;
   * the caller keeps the title and otherwise treats this as the error it wraps.
   */
  setupError?: AppErrorPayload;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  prompt: string;
  history: ChatTurn[];
  lang: UiLanguage;
  /** Optional system prompt; Rust appends a language instruction. */
  system?: string;
  /** Ask for a JSON object response (Ollama `format:json` / OpenRouter `response_format`). */
  jsonMode?: boolean;
}

/** Token usage reported at the end of a streamed answer (cost indicator). */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Cost in USD when the provider reports it (OpenRouter `usage.cost`). */
  costUsd?: number;
}

/** Events on `chat_stream`: any number of `delta`s, then exactly one `done` or `error`. */
export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: ChatUsage }
  | { type: 'error'; error: AppErrorPayload };

export type HealthErrorKind =
  'none' | 'dns' | 'timeout' | 'tls' | 'refused' | 'http' | 'blocked' | 'other';

export interface LinkHealthResult {
  url: string;
  /** true = reachable (2xx/3xx, or 401/403/429 which mean "alive but protected"). */
  ok: boolean;
  /** true only for definitive failures: DNS NXDOMAIN, 404, 410. */
  definitelyBroken: boolean;
  status?: number;
  finalUrl?: string;
  previewBlocked: boolean;
  errorKind: HealthErrorKind;
  error?: string;
}

/**
 * Emitted on `health-scan-progress` while `check_links_health` runs. Per call, not cumulative:
 * `processed`/`total` describe that one call's `urls`, not the whole scan.
 */
export interface HealthScanProgressEvent {
  runId: string;
  processed: number;
  total: number;
}

export type SnapshotKind = 'image' | 'challenge' | 'error' | 'runtimeMissing';

/** `capture_snapshot` resolves for every page-level outcome; rejects only invalid/blocked input. */
export interface SnapshotResult {
  kind: SnapshotKind;
  /** File name inside the snapshot directory (NOT an absolute path). */
  fileName?: string;
  reason?: string;
}

/** `cache_remote_image` kind: favicon (max 512 KB) or og:image (max 5 MB). */
export type RemoteImageKind = 'favicon' | 'image';

/** Result of `maintain_snapshots` (start-up maintenance). */
export interface SnapshotMaintenanceReport {
  /** Files deleted because no resource references them. */
  deletedUnreferenced: number;
  /** Referenced files evicted by the 500 MB size cap; their references must be cleared. */
  evicted: string[];
  /** Directory size after maintenance, in bytes. */
  totalBytes: number;
}

export type BrowserFamily = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'opera' | 'firefox';

/** Why a profile cannot be imported; the UI shows a translated sentence for it. */
export type BrowserProfileError = 'locked' | 'unreadable';

export interface DetectedProfile {
  /** Opaque id; the renderer never sees filesystem paths. */
  id: string;
  browser: BrowserFamily;
  profileName: string;
  bookmarkCount: number;
  /** Set when the profile could not be read (e.g. Firefox DB locked and copy failed). */
  error?: BrowserProfileError;
}

export interface ImportedBookmark {
  url: string;
  title: string;
  /** Folder path from the root, e.g. ["Bookmarks bar", "Dev", "Rust"]. */
  folderPath: string[];
  /** Epoch milliseconds, already converted from browser-specific epochs. */
  addedAt?: number;
  /** Epoch ms of the Netscape `LAST_MODIFIED` attribute (HTML import only). */
  updatedAt?: number;
  /** Tags from a Netscape `TAGS` attribute (e.g. a MYNK HTML export). */
  tags?: string[];
  /** Description from a `<DD>` element (e.g. a MYNK HTML export). */
  description?: string;
}

/** One bookmark an agent dropped into `<data dir>/inbox`; Rust validates every field first. */
export interface InboxEntry {
  url: string;
  title?: string;
  tags: string[];
  note?: string;
  /** Who added it, e.g. `mcp:claude-code` or `cli`. Logged, never used for a decision. */
  source: string;
  /** When the agent added it (epoch ms). */
  createdAt: number;
}

/** A pending inbox entry and its file name (never a path), passed back to `ack_agent_inbox`. */
export interface InboxFile {
  name: string;
  entry: InboxEntry;
}

/** Status of the agent bridge, shown in Settings › Agents. */
export interface AgentBridgeInfo {
  /** Absolute path of `mynk-mcp` for the agent's config; `null` if not installed. */
  mcpPath: string | null;
  mcpAvailable: boolean;
  /** Inbox entries waiting to be imported. */
  inboxPending: number;
}

export type ExportFormat = 'json' | 'html';
