/** Fakes the Tauri `invoke()` boundary; uncalled commands fall back to a harmless default. */
import { clearMocks, mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import type {
  AgentBridgeInfo,
  AISettings,
  AppErrorKind,
  LibraryLoadResult,
  SnapshotMaintenanceReport,
  SnapshotResult,
} from '../services/ipcTypes';

export type IpcArgs = Record<string, unknown>;
export type IpcHandler = (args: IpcArgs, cmd: string) => unknown;

export interface RustMock {
  /** Every call in order, including the ones served by a default. */
  calls: { cmd: string; args: IpcArgs }[];
  /** Arguments of every call of one command. */
  argsOf: (cmd: string) => IpcArgs[];
  countOf: (cmd: string) => number;
  /** Replaces a handler while the test runs. */
  on: (cmd: string, handler: IpcHandler) => void;
  /** Commands that had no handler and no default; `stopRust` fails the test when any remain. */
  unhandled: string[];
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3',
  openrouterModel: '',
  hasOpenrouterApiKey: false,
  allowPrivateNetwork: false,
  embeddingModel: '',
};

const EMPTY_MAINTENANCE: SnapshotMaintenanceReport = {
  deletedUnreferenced: 0,
  evicted: [],
  totalBytes: 0,
};

const CAPTURE_OK: SnapshotResult = { kind: 'image', fileName: 'snap-default.png' };

/** What `getVersion()` reports under test (`tauri.conf.json#version`). */
export const TEST_APP_VERSION = '0.1.0';

/** Agent bridge with the MCP program installed (the Agents tab's normal case). */
export const DEFAULT_AGENT_BRIDGE: AgentBridgeInfo = {
  mcpPath: 'C:\\Program Files\\MYNK\\mynk-mcp.exe',
  mcpAvailable: true,
  inboxPending: 0,
};

/** Rejection payload in the shape every Rust command uses. */
export const ipcReject = (kind: AppErrorKind, message: string = kind, status?: number): never => {
  const payload: { kind: AppErrorKind; message: string; status?: number } = { kind, message };
  if (status !== undefined) payload.status = status;
  throw payload;
};

/** `library_load` result: the stored JSON and whether it came from the `.bak` file. */
export const libraryLoad = (
  json: string | null,
  recoveredFromBackup = false,
): LibraryLoadResult => ({ json, recoveredFromBackup });

const defaults = (): Record<string, IpcHandler> => ({
  library_load: () => libraryLoad(null),
  library_save: () => null,
  get_snapshot_dir: () => 'C:\\mynk\\snapshots',
  maintain_snapshots: () => EMPTY_MAINTENANCE,
  delete_snapshots: () => null,
  reset_snapshots: () => 0,
  snapshot_dir_bytes: () => 0,
  capture_snapshot: () => CAPTURE_OK,
  cancel_snapshot_captures: () => null,
  cache_remote_image: () => ipcReject('network', 'no cache in tests'),
  save_uploaded_preview: () => 'upload-default.png',
  get_ai_settings: () => DEFAULT_AI_SETTINGS,
  update_ai_settings: (args) => ({
    ...DEFAULT_AI_SETTINGS,
    ...(args.payload as Partial<AISettings>),
  }),
  set_openrouter_api_key: () => null,
  clear_openrouter_api_key: () => null,
  list_ollama_models: () => [],
  list_openrouter_models: () => [],
  // Rust always reports a latency, and a `reason` whenever the test failed.
  test_provider_connection: () => ({ ok: true, message: 'ok', latencyMs: 12 }),
  cancel_request: () => null,
  // Background enrichment a flow test did not ask about fails fast instead of calling out.
  analyze_url: () => ipcReject('internal', 'no analysis in tests'),
  open_external_url: () => null,
  check_links_health: () => [],
  cancel_health_scan: () => null,
  detect_browsers: () => [],
  read_browser_bookmarks: () => [],
  export_library: () => 'C:\\Downloads\\mynk.json',
  reveal_in_folder: () => null,
  // Empty inbox so an app-level flow test can boot without an explicit handler.
  peek_agent_inbox: () => [],
  ack_agent_inbox: () => null,
  get_agent_bridge_info: () => DEFAULT_AGENT_BRIDGE,
  'plugin:app|version': () => TEST_APP_VERSION,
  'plugin:log|log': () => null,
  'plugin:updater|check': () => null,
});

/** Installs the fake backend; unpassed commands fall back to the defaults above. */
export const mockRust = (handlers: Record<string, IpcHandler> = {}): RustMock => {
  const table: Record<string, IpcHandler> = { ...defaults(), ...handlers };
  const mock: RustMock = {
    calls: [],
    argsOf: (cmd) => mock.calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    countOf: (cmd) => mock.calls.filter((c) => c.cmd === cmd).length,
    on: (cmd, handler) => {
      table[cmd] = handler;
    },
    unhandled: [],
  };

  mockIPC(
    (cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as IpcArgs;
      mock.calls.push({ cmd, args });
      const handler = table[cmd];
      if (!handler) {
        mock.unhandled.push(cmd);
        return ipcReject('internal', `no test handler for "${cmd}"`);
      }
      return handler(args, cmd);
    },
    { shouldMockEvents: true },
  );

  mockConvertFileSrc('windows');
  active = mock;
  return mock;
};

let active: RustMock | null = null;

/**
 * Removes the fake backend so `isDesktopRuntime()` reports a browser again; throws when a
 * command had no handler, since a misspelled command name would otherwise pass unnoticed.
 */
export const stopRust = (): void => {
  const unhandled = active?.unhandled ?? [];
  active = null;
  clearMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  if (unhandled.length > 0) {
    throw new Error(`no test handler for: ${[...new Set(unhandled)].join(', ')}`);
  }
};

/** A promise plus its resolvers, for commands the test wants to settle by hand. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
