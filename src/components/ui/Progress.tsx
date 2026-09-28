import React from 'react';
import { cx } from './cx';

type ProgressTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

const TONES: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-fg-muted',
};

interface ProgressBase {
  value: number;
  max?: number;
  /** Spoken value, e.g. "12 of 40". */
  valueText?: string;
  tone?: ProgressTone;
  size?: 'sm' | 'md';
  className?: string;
}

/** Named either by its own text or by a visible element, never by both. */
export type ProgressProps = ProgressBase &
  ({ label: string; labelledBy?: never } | { labelledBy: string; label?: never });

/** `role="progressbar"` with real aria-value*. */
export const Progress: React.FC<ProgressProps> = ({
  value,
  max = 100,
  label,
  labelledBy,
  valueText,
  tone = 'accent',
  size = 'sm',
  className,
}) => {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(safeMax, Math.max(0, value));
  const percent = (clamped / safeMax) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      className={cx(
        'w-full overflow-hidden rounded-full bg-surface-3',
        size === 'sm' ? 'h-1.5' : 'h-2',
        className,
      )}
    >
      <div
        className={cx('h-full rounded-full transition-[width] duration-slow ease-out', TONES[tone])}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
};
