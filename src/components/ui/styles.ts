/** Shared class maps for the primitives (kept out of .tsx files for fast refresh). */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'dangerSoft';
export type ButtonSize = 'sm' | 'md';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent/90 active:bg-accent/80',
  secondary:
    'border border-line bg-surface-2 text-fg hover:border-line-strong hover:bg-surface-3 active:bg-surface-active',
  ghost: 'text-fg-secondary hover:bg-surface-hover hover:text-fg active:bg-surface-active',
  danger: 'bg-danger-strong text-danger-contrast hover:bg-danger-strong-hover',
  soft: 'bg-accent-soft text-accent-text hover:bg-accent/20',
  dangerSoft: 'bg-danger/10 text-danger hover:bg-danger/15',
};

export const BUTTON_ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16 };

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** Soft fill + text color per tone, shared by badges and the health stat tiles. */
export const TONE_SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-fg-secondary',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
};

/** Inset panel inside a page section or card. */
export const INSET_SURFACE = 'rounded-md border border-line-subtle bg-surface-2';

export type PanelTone = 'danger' | 'warning' | 'accent';

/** Tinted border and fill of a callout box. */
export const TONE_PANEL: Record<PanelTone, string> = {
  danger: 'border-danger/30 bg-danger/10',
  warning: 'border-warning/30 bg-warning/10',
  accent: 'border-accent/40 bg-accent-soft',
};

/**
 * Surface of any text field. The ring follows `.field-control` itself, so a button inside the
 * field (scope chip, keyword remove) shows only its own ring instead of two.
 */
export const FIELD_SURFACE =
  'rounded-md border bg-surface-2 transition-colors duration-fast has-[.field-control:focus]:border-accent-text has-[.field-control:focus]:ring-2 has-[.field-control:focus]:ring-accent-ring';
export const FIELD_BORDER = 'border-line hover:border-line-strong';
export const FIELD_BORDER_INVALID =
  'border-danger has-[.field-control:focus]:border-danger has-[.field-control:focus]:ring-danger/30';

/** Hidden until the surrounding `group` is hovered or holds focus (card row actions). */
export const REVEAL_ON_HOVER = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100';

/** Bottom offset of a corner overlay that has to clear the batch action dock. */
export const dockAwareBottom = (dockVisible: boolean): string =>
  dockVisible ? 'bottom-24' : 'bottom-6';
