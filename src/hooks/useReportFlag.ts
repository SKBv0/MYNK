import { useEffect } from 'react';
import { useLatest } from './useLatest';

/** Reports a boolean to a parent callback (which may change between renders); `false` on unmount. */
export const useReportFlag = (
  report: ((value: boolean) => void) | undefined,
  value: boolean,
): void => {
  const latest = useLatest(report);
  useEffect(() => {
    latest.current?.(value);
  }, [latest, value]);
  useEffect(() => () => latest.current?.(false), [latest]);
};
