import React, { useEffect, useId, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';
import { useLayer } from './layerStack';
import { rovingIndex } from './roving';

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown under the label; for disabled items it explains why (e.g. Synthesis). */
  description?: string | undefined;
  shortcut?: string;
}

export interface MenuTriggerProps {
  id: string;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  ref: React.Ref<HTMLButtonElement>;
}

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  items: readonly MenuItem[];
  /** Renders the trigger; spread the given props on a button. */
  trigger: (props: MenuTriggerProps) => React.ReactElement;
}

/** Action menu (WAI-ARIA menu button); disabled items stay focusable so their description reads. */
export const Menu: React.FC<MenuProps> = ({ label, items, trigger }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const triggerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useLayer(open, () => close());

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    close();
    item.onSelect();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      // Hand focus back to the trigger before the item unmounts.
      event.preventDefault();
      close();
      return;
    }
    const next = rovingIndex(
      event.key,
      active,
      items.map(() => true),
      'vertical',
    );
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {trigger({
        id: triggerId,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        ref: triggerRef,
        onClick: () => (open ? close() : openAt(0)),
        onKeyDown: (event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openAt(0);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openAt(items.length - 1);
          }
        },
      })}
      {open && (
        <div
          id={menuId}
          role="menu"
          // One name only: an explicit `label` wins, otherwise the trigger names the menu.
          aria-label={label || undefined}
          aria-labelledby={label ? undefined : triggerId}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-overlay mt-1 w-72 animate-fade-in rounded-md border border-line bg-surface-1 p-1 shadow-lg"
        >
          {items.map((item, index) => {
            const Icon = item.icon;
            const descriptionId = item.description ? `${menuId}-${item.id}-d` : undefined;
            return (
              <button
                key={item.id}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={index === active ? 0 : -1}
                aria-disabled={item.disabled || undefined}
                aria-describedby={descriptionId}
                onClick={() => select(item)}
                onMouseEnter={() => setActive(index)}
                className={cx(
                  'flex w-full items-start gap-3 rounded-sm px-3 py-2 text-left transition-colors duration-fast',
                  item.disabled ? 'cursor-not-allowed' : 'hover:bg-surface-hover',
                  index === active && !item.disabled && 'bg-surface-hover',
                )}
              >
                {Icon && (
                  <Icon
                    size={16}
                    aria-hidden
                    className={cx(
                      'mt-0.5 shrink-0',
                      item.disabled ? 'text-fg-disabled' : 'text-fg-muted',
                    )}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      'block text-base font-medium',
                      item.disabled ? 'text-fg-muted' : 'text-fg',
                    )}
                  >
                    {item.label}
                  </span>
                  {item.description && (
                    <span id={descriptionId} className="mt-0.5 block text-sm text-fg-muted">
                      {item.description}
                    </span>
                  )}
                </span>
                {item.shortcut && (
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-fg-muted">
                    {item.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
