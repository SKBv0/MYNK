import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { TONE_SOFT, type BadgeTone } from './styles';

export type { BadgeTone };

/** Icon tint for the `overlay` style (badges on top of preview images). */
const OVERLAY_ICON: Record<BadgeTone, string> = {
  neutral: 'text-fg-media',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** `overlay` = dark translucent chip for use on images. */
  variant?: 'soft' | 'overlay';
  icon?: LucideIcon;
}

export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  variant = 'soft',
  icon: Icon,
  className,
  children,
  ...rest
}) => (
  <span
    className={cx(
      'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-sm px-2 text-xs font-medium',
      variant === 'overlay' ? 'bg-surface-media text-fg-media' : TONE_SOFT[tone],
      className,
    )}
    {...rest}
  >
    {Icon && (
      <Icon
        size={12}
        aria-hidden
        className={cx('shrink-0', variant === 'overlay' && OVERLAY_ICON[tone])}
      />
    )}
    <span className="truncate">{children}</span>
  </span>
);
