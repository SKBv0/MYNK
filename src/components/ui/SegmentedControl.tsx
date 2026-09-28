import React, { useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { Tooltip } from './Tooltip';
import { rovingIndex } from './roving';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Extra tooltip text (e.g. a contrast ratio); defaults to the label for icon-only items. */
  hint?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the radio group. */
  label: string;
  value: T | null;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  /** Show only icons (labels become aria-label + tooltip). */
  iconOnly?: boolean;
  /** Classes for the visible label text (e.g. `hidden 2xl:inline` to collapse on narrow widths). */
  labelClassName?: string;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
}

/** Single-choice switch: `role="radiogroup"` with roving tabindex. */
export const SegmentedControl = <T extends string>({
  label,
  value,
  onChange,
  options,
  iconOnly = false,
  labelClassName,
  size = 'md',
  fullWidth = false,
}: SegmentedControlProps<T>) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const next = rovingIndex(
      event.key,
      index,
      options.map((o) => !o.disabled),
    );
    const target = next === null ? undefined : options[next];
    if (next === null || !target) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(target.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        'inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5',
        fullWidth && 'flex w-full',
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const Icon = option.icon;
        const button = (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly || labelClassName ? option.label : undefined}
            disabled={option.disabled}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium transition-colors duration-fast',
              'disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'h-7 text-sm' : 'h-8 text-sm',
              iconOnly ? (size === 'sm' ? 'w-7' : 'w-8') : 'px-2.5',
              fullWidth && 'flex-1',
              checked
                ? 'bg-surface-1 text-fg shadow-sm'
                : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
            )}
          >
            {Icon && (
              <Icon
                size={size === 'sm' ? 14 : 16}
                aria-hidden
                className={checked ? 'text-accent-text' : undefined}
              />
            )}
            {!iconOnly && <span className={labelClassName}>{option.label}</span>}
          </button>
        );
        const tip = option.hint ?? (iconOnly || labelClassName ? option.label : undefined);
        return tip ? (
          <Tooltip key={option.value} content={tip} describe={Boolean(option.hint)}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
};
