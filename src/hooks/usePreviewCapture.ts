import { useCallback } from 'react';
import { useAppStore } from '../store';
import {
  cancelPreviewCapture,
  pausePreviewCapture,
  refreshPreview,
  resumePreviewCapture,
  startPreviewCapture,
  uploadPreview,
} from '../store/jobs/preview';
import { isJobActive } from '../store/jobs/shared';

/** Opens the OS file picker and resolves with the chosen image (or null when cancelled). */
const pickImageFile = (): Promise<File | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });

/** Preview capture queue + manual upload. */
export const usePreviewCapture = () => {
  const progress = useAppStore((s) => s.jobs.preview);
  const upload = useCallback(async (resourceId: string) => {
    const file = await pickImageFile();
    if (file) await uploadPreview(resourceId, file);
  }, []);
  return {
    progress,
    isRunning: isJobActive(progress),
    start: startPreviewCapture,
    refresh: refreshPreview,
    cancel: cancelPreviewCapture,
    pause: pausePreviewCapture,
    resume: resumePreviewCapture,
    upload,
  };
};
