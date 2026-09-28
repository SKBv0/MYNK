import { useAppStore } from '../store';
import {
  cancelEnrichment,
  pauseEnrichment,
  resumeEnrichment,
  startEnrichmentConfirmed,
} from '../store/jobs/enrich';
import { isJobActive } from '../store/jobs/shared';

/** Bulk AI analysis: progress from the jobs slice + stable actions (the job outlives the view). */
export const useEnrichment = () => {
  const progress = useAppStore((s) => s.jobs.enrich);
  return {
    progress,
    isRunning: isJobActive(progress),
    start: startEnrichmentConfirmed,
    cancel: cancelEnrichment,
    pause: pauseEnrichment,
    resume: resumeEnrichment,
  };
};
