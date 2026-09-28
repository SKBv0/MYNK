import { useAppStore } from '../store';
import { cancelHealthScan, startHealthScan } from '../store/jobs/health';

/** Link health scan: progress from the jobs slice + stable actions. */
export const useHealthScan = () => {
  const progress = useAppStore((s) => s.jobs.health);
  return {
    progress,
    isRunning: progress?.state === 'running',
    start: startHealthScan,
    cancel: cancelHealthScan,
  };
};
