/**
 * Link health IPC wrappers. The scan runs in Rust (8 concurrent requests, max 2 per host)
 * and emits `health-scan-progress` events.
 */
import { listen } from '@tauri-apps/api/event';
import { call, desktopCall } from './ipc';
import type { HealthScanProgressEvent, LinkHealthResult } from './ipcTypes';

export const HEALTH_SCAN_PROGRESS_EVENT = 'health-scan-progress';

/** Resolves with the results gathered so far when the run is cancelled. */
export const checkLinksHealth = (urls: string[], runId: string): Promise<LinkHealthResult[]> =>
  call<LinkHealthResult[]>('check_links_health', { urls, runId });

export const cancelHealthScan = (runId: string): Promise<void> =>
  call<void>('cancel_health_scan', { runId });

/** Subscribes to scan progress; resolves with an unlisten function. */
export const onHealthScanProgress = (
  cb: (e: HealthScanProgressEvent) => void,
): Promise<() => void> =>
  desktopCall(() =>
    listen<HealthScanProgressEvent>(HEALTH_SCAN_PROGRESS_EVENT, (event) => cb(event.payload)),
  );
