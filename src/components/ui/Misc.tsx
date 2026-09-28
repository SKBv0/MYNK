import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';

/** Loading placeholder. The pulse stops under prefers-reduced-motion. */
export const Skeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div aria-hidden className={cx('animate-pulse rounded-md bg-surface-3', className)} />
);

export const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <kbd
    className={cx(
      'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-surface-2 px-1.5 font-mono text-xs text-fg-muted',
      className,
    )}
  >
    {children}
  </kbd>
);

/** Typography for rendered Markdown (styles: `.prose-mynk` in index.css). */
export const Prose: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="prose-mynk">{children}</div>
);

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  /** `compact` for panels and lists, `page` for full views. */
  size?: 'compact' | 'page';
  headingLevel?: 'h2' | 'h3';
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  actions,
  footer,
  size = 'page',
  headingLevel: Heading = 'h2',
  className,
}) => (
  <div
    className={cx(
      'flex flex-col items-center justify-center text-center',
      size === 'page' ? 'min-h-80 px-6 py-16' : 'px-4 py-8',
      className,
    )}
  >
    <span
      aria-hidden
      className={cx(
        'mb-4 flex items-center justify-center rounded-lg border border-line bg-surface-2 text-accent-text',
        size === 'page' ? 'h-14 w-14' : 'h-10 w-10',
      )}
    >
      <Icon size={size === 'page' ? 24 : 18} />
    </span>
    <Heading className={cx('font-semibold text-fg', size === 'page' ? 'text-lg' : 'text-base')}>
      {title}
    </Heading>
    {description && <p className="mt-2 max-w-sm text-base text-fg-muted">{description}</p>}
    {actions && (
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div>
    )}
    {footer && <div className="mt-8 text-sm text-fg-muted">{footer}</div>}
  </div>
);

export const PageHeader: React.FC<{
  title: string;
  description?: string;
  actions?: React.ReactNode;
}> = ({ title, description, actions }) => (
  <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      <h1 className="font-display text-xl font-bold text-fg">{title}</h1>
      {description && <p className="mt-1 text-base text-fg-muted">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </header>
);

export const SectionTitle: React.FC<{
  children: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ children, description, actions }) => (
  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className="text-md font-semibold text-fg">{children}</h2>
      {description && <p className="mt-0.5 text-base text-fg-muted">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);
