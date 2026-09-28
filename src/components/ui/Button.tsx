import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { Spinner } from './Spinner';
import { BUTTON_VARIANTS, BUTTON_ICON_SIZE, type ButtonSize, type ButtonVariant } from './styles';

export type { ButtonSize, ButtonVariant };

export interface ButtonProps extends React.ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon | undefined;
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-control-sm gap-1.5 px-3 text-sm',
  md: 'h-control-md gap-2 px-4 text-base',
};

/** Swallows a click on a busy button, including the form submit it would trigger. */
const preventClick = (event: React.MouseEvent): void => event.preventDefault();

/** The one button. Variants and sizes come from the design tokens. */
export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  className,
  children,
  disabled,
  type = 'button',
  onClick,
  ...rest
}) => {
  const iconSize = BUTTON_ICON_SIZE[size];
  // Native `disabled` would drop keyboard focus to the body while the action runs.
  const blocked = loading && !disabled;
  return (
    <button
      type={type}
      disabled={disabled}
      aria-disabled={blocked || undefined}
      aria-busy={loading || undefined}
      onClick={blocked ? preventClick : onClick}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
        SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : Icon ? <Icon size={iconSize} aria-hidden /> : null}
      {children}
    </button>
  );
};
