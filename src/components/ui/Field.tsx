import React, { useId } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from './cx';
import { FIELD_BORDER, FIELD_BORDER_INVALID, FIELD_SURFACE } from './styles';
import { describedBy, errorId, hintId } from './fieldIds';

interface FieldChromeProps {
  id: string;
  label?: string | undefined;
  hideLabel?: boolean | undefined;
  hint?: React.ReactNode;
  error?: string | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}

/** Label, hint and error around a control; custom controls use it with `describedBy`. */
export const FieldChrome: React.FC<FieldChromeProps> = ({
  id,
  label,
  hideLabel,
  hint,
  error,
  className,
  children,
}) => (
  <div className={cx('min-w-0', className)}>
    {label && (
      <label
        htmlFor={id}
        className={hideLabel ? 'sr-only' : 'mb-1.5 block text-sm font-medium text-fg-secondary'}
      >
        {label}
      </label>
    )}
    {children}
    {error ? (
      <p id={errorId(id)} className="mt-1.5 text-sm text-danger">
        {error}
      </p>
    ) : hint ? (
      <p id={hintId(id)} className="mt-1.5 text-sm text-fg-muted">
        {hint}
      </p>
    ) : null}
  </div>
);

type ControlSize = 'md' | 'lg';
const HEIGHTS: Record<ControlSize, string> = {
  md: 'h-control-md',
  lg: 'h-control-lg',
};

interface FieldProps {
  label?: string | undefined;
  hideLabel?: boolean | undefined;
  hint?: React.ReactNode;
  error?: string | undefined;
  containerClassName?: string | undefined;
}

export interface InputProps extends Omit<React.ComponentPropsWithRef<'input'>, 'size'>, FieldProps {
  icon?: LucideIcon;
  trailing?: React.ReactNode;
  size?: ControlSize;
  /** Content rendered inside the field before the input (e.g. a scope chip). */
  leading?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({
  id: idProp,
  label,
  hideLabel,
  hint,
  error,
  containerClassName,
  icon: Icon,
  trailing,
  leading,
  size = 'md',
  className,
  'aria-describedby': ariaDescribedBy,
  ...rest
}) => {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldChrome
      id={id}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      className={containerClassName}
    >
      <div
        className={cx(
          'flex items-center gap-2 px-3',
          FIELD_SURFACE,
          error ? FIELD_BORDER_INVALID : FIELD_BORDER,
          HEIGHTS[size],
        )}
      >
        {Icon && <Icon size={16} className="shrink-0 text-fg-muted" aria-hidden />}
        {leading}
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error, ariaDescribedBy)}
          className={cx(
            'field-control h-full min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-fg-muted',
            className,
          )}
          {...rest}
        />
        {trailing}
      </div>
    </FieldChrome>
  );
};

export interface TextareaProps extends React.ComponentPropsWithRef<'textarea'>, FieldProps {}

export const Textarea: React.FC<TextareaProps> = ({
  id: idProp,
  label,
  hideLabel,
  hint,
  error,
  containerClassName,
  className,
  'aria-describedby': ariaDescribedBy,
  ...rest
}) => {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldChrome
      id={id}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      className={containerClassName}
    >
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error, ariaDescribedBy)}
        className={cx(
          'field-control block w-full resize-y px-3 py-2 text-base text-fg placeholder:text-fg-muted',
          FIELD_SURFACE,
          error ? FIELD_BORDER_INVALID : FIELD_BORDER,
          className,
        )}
        {...rest}
      />
    </FieldChrome>
  );
};

export interface SelectProps extends React.ComponentPropsWithRef<'select'>, FieldProps {}

export const Select: React.FC<SelectProps> = ({
  id: idProp,
  label,
  hideLabel,
  hint,
  error,
  containerClassName,
  className,
  children,
  'aria-describedby': ariaDescribedBy,
  ...rest
}) => {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldChrome
      id={id}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      className={containerClassName}
    >
      <div
        className={cx(
          'relative flex items-center',
          FIELD_SURFACE,
          error ? FIELD_BORDER_INVALID : FIELD_BORDER,
          HEIGHTS.md,
        )}
      >
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error, ariaDescribedBy)}
          className={cx(
            'field-control h-full w-full cursor-pointer appearance-none bg-transparent pl-3 pr-9 text-base text-fg',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          size={16}
          className="pointer-events-none absolute right-3 text-fg-muted"
          aria-hidden
        />
      </div>
    </FieldChrome>
  );
};

export interface CheckboxProps extends Omit<
  React.ComponentPropsWithRef<'input'>,
  'type' | 'children'
> {
  label: React.ReactNode;
  description?: React.ReactNode;
}

/** Native checkbox (kept in the tab order via `sr-only`) with a token-styled box. */
export const Checkbox: React.FC<CheckboxProps> = ({
  id: idProp,
  label,
  description,
  checked,
  disabled,
  ...rest
}) => {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <label
      htmlFor={id}
      className={cx(
        'flex items-start gap-3',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-description` : undefined}
        {...rest}
      />
      <span
        aria-hidden
        className={cx(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors duration-fast',
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent-text',
          checked
            ? 'border-accent bg-accent text-accent-contrast'
            : 'border-line-strong bg-surface-2 text-transparent',
        )}
      >
        <Check size={12} strokeWidth={3} />
      </span>
      <span className="min-w-0">
        <span className="block text-base font-medium text-fg">{label}</span>
        {description && (
          <span id={`${id}-description`} className="mt-0.5 block text-sm text-fg-muted">
            {description}
          </span>
        )}
      </span>
    </label>
  );
};
