import React, { useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { rovingIndex } from './roving';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
}

export interface TabsProps<T extends string> {
  label: string;
  /** Prefix for tab / panel ids: `${idBase}-tab-${id}` and `${idBase}-panel-${id}`. */
  idBase: string;
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** WAI-ARIA tabs with automatic activation (arrow keys, Home, End). */
export const Tabs = <T extends string>({
  label,
  idBase,
  items,
  value,
  onChange,
  className,
}: TabsProps<T>) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('flex items-center gap-1 border-b border-line-subtle', className)}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            id={`${idBase}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              const next = rovingIndex(
                event.key,
                index,
                items.map(() => true),
                'horizontal',
              );
              const target = next === null ? undefined : items[next];
              if (next === null || !target) return;
              event.preventDefault();
              refs.current[next]?.focus();
              onChange(target.id);
            }}
            className={cx(
              '-mb-px inline-flex h-control-md items-center gap-2 border-b-2 px-3 text-base font-medium transition-colors duration-fast',
              selected ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {Icon && <Icon size={16} aria-hidden />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
};

export const TabPanel: React.FC<{
  idBase: string;
  id: string;
  children: React.ReactNode;
  className?: string;
}> = ({ idBase, id, children, className }) => (
  <div
    role="tabpanel"
    id={`${idBase}-panel-${id}`}
    aria-labelledby={`${idBase}-tab-${id}`}
    tabIndex={0}
    className={className}
  >
    {children}
  </div>
);
