import React from 'react';
import { cx } from './cx';

export type CardVariant = 'flat' | 'interactive';

const VARIANTS: Record<CardVariant, string> = {
  flat: 'border-line-subtle bg-surface-1',
  interactive:
    'border-line-subtle bg-surface-1 transition-colors duration-fast hover:border-line-strong hover:bg-surface-2 focus-within:border-line-strong',
};

const PADDING = { none: '', sm: 'p-3', md: 'p-5', lg: 'p-6' } as const;

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  variant?: CardVariant;
  selected?: boolean;
  padding?: keyof typeof PADDING;
  as?: 'div' | 'article';
  /** For a card the app focuses itself (see `data-focus-container`). */
  ref?: React.Ref<HTMLDivElement>;
}

/** Surface container. Interactive cards get their action from `CardAction` (a real button). */
export const Card: React.FC<CardProps> = ({
  variant = 'flat',
  selected = false,
  padding = 'none',
  as: Tag = 'div',
  className,
  ...rest
}) => (
  <Tag
    className={cx(
      'relative rounded-lg border',
      VARIANTS[variant],
      PADDING[padding],
      selected && 'border-accent ring-1 ring-accent',
      className,
    )}
    {...rest}
  />
);

/**
 * The card's primary action as a real `<button>`, its hit area stretched over the whole card.
 * The focus ring sits inside the card edge, so a card with `overflow-hidden` does not clip it.
 */
export const CardAction: React.FC<React.ComponentPropsWithRef<'button'>> = ({
  className,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    data-own-focus-ring=""
    className={cx(
      'text-left',
      'after:absolute after:inset-0 after:rounded-lg after:content-[""] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent-text',
      className,
    )}
    {...rest}
  />
);
