import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { Spinner } from './Spinner';
import { Tooltip, type TooltipSide } from './Tooltip';

export type IconButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger' | 'overlay';
export type IconButtonSize = 'xs' | 'sm' | 'md';

export interface IconButtonProps extends Omit<
  React.ComponentPropsWithRef<'button'>,
  'children' | 'aria-label' | 'title'
> {
  /** Required accessible name; also shown as the tooltip. */
  label: string;
  icon: LucideIcon;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Toggle buttons: sets `aria-pressed`. */
  pressed?: boolean;
  loading?: boolean;
  /** `false` hides the tooltip; a string shows extra text instead of the label. */
  tooltip?: boolean | string;
  tooltipSide?: TooltipSide;
  iconClassName?: string | undefined;
}

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: 'text-fg-muted hover:bg-surface-hover hover:text-fg active:bg-surface-active',
  secondary: 'border border-line bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg',
  primary: 'bg-accent text-accent-contrast hover:bg-accent/90',
  danger: 'text-danger hover:bg-danger/10',
  overlay: 'bg-surface-media text-fg-media hover:bg-surface-media-hover',
};

const SIZES: Record<IconButtonSize, { box: string; icon: number }> = {
  xs: { box: 'h-7 w-7', icon: 14 },
  sm: { box: 'h-control-sm w-control-sm', icon: 16 },
  md: { box: 'h-control-md w-control-md', icon: 18 },
};

/** Swallows a click on a busy button, including the form submit it would trigger. */
const preventClick = (event: React.MouseEvent): void => event.preventDefault();

/** The label is mandatory, so an unnamed icon button does not compile. */
export const IconButton: React.FC<IconButtonProps> = ({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'sm',
  pressed,
  loading = false,
  tooltip = true,
  tooltipSide = 'top',
  iconClassName,
  className,
  disabled,
  type = 'button',
  onClick,
  ...rest
}) => {
  const box = SIZES[size];
  // Native `disabled` would drop keyboard focus to the body while the action runs.
  const blocked = loading && !disabled;
  const button = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      aria-disabled={blocked || undefined}
      disabled={disabled}
      onClick={blocked ? preventClick : onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
        box.box,
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={box.icon} />
      ) : (
        <Icon size={box.icon} className={iconClassName} aria-hidden />
      )}
    </button>
  );
  if (tooltip === false) return button;
  return (
    <Tooltip
      content={typeof tooltip === 'string' ? tooltip : label}
      side={tooltipSide}
      describe={typeof tooltip === 'string'}
    >
      {button}
    </Tooltip>
  );
};
