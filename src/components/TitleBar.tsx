import React, { useEffect } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';
import { isDesktopRuntime } from '../services/ipc';
import { reportError } from '../lib/errors';
import { useLocationTitle } from '../hooks/useLocationTitle';
import { useAppStore } from '../store';
import { cx } from './ui';

const withWindow = async (
  action: (win: import('@tauri-apps/api/window').Window) => Promise<void>,
): Promise<void> => {
  if (!isDesktopRuntime()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await action(getCurrentWindow());
  } catch (error) {
    reportError(error, 'titlebar');
  }
};

const minimize = () => void withWindow((win) => win.minimize());
const toggleMaximize = () => void withWindow((win) => win.toggleMaximize());
const startDragging = () => void withWindow((win) => win.startDragging());
// The persistence close handler flushes first and asks before dropping unsaved changes.
const close = () => void withWindow((win) => win.close());

/** Title bar of the frameless window: drags it, and a double click maximizes or restores it. */
export default function TitleBar() {
  const { t } = useTranslation();
  const title = useLocationTitle();
  // Brand shown here only while the sidebar (which already carries it) is collapsed.
  const showBrand = useAppStore((s) => s.isSidebarCollapsed);

  useEffect(() => {
    document.title = `${title} · MYNK`;
  }, [title]);

  return (
    <header
      data-chrome
      className="relative z-titlebar flex h-titlebar shrink-0 items-center border-b border-line-subtle bg-surface-1"
    >
      <div
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 px-3"
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          if (event.detail === 2) toggleMaximize();
          else startDragging();
        }}
      >
        {showBrand && (
          <>
            <span className="font-display text-sm font-bold text-accent-text">MYNK</span>
            <span aria-hidden className="text-fg-disabled">
              /
            </span>
          </>
        )}
        <span className="truncate text-sm text-fg-secondary">{title}</span>
      </div>
      <div className="flex h-full shrink-0 items-stretch">
        <WindowButton icon={Minus} onClick={minimize} label={t.titlebar.minimize} />
        <WindowButton
          icon={Square}
          onClick={toggleMaximize}
          label={t.titlebar.maximize}
          iconSize={12}
        />
        <WindowButton icon={X} onClick={close} label={t.titlebar.close} isClose />
      </div>
    </header>
  );
}

function WindowButton({
  icon: Icon,
  onClick,
  label,
  isClose = false,
  iconSize = 16,
}: {
  icon: React.ElementType;
  onClick: () => void;
  label: string;
  isClose?: boolean;
  iconSize?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      // Outside the Tab order, like the native caption buttons they replace.
      tabIndex={-1}
      className={cx(
        'flex w-window-control items-center justify-center text-fg-secondary transition-colors duration-fast',
        isClose
          ? 'hover:bg-danger-strong hover:text-danger-contrast'
          : 'hover:bg-surface-hover hover:text-fg',
      )}
    >
      <Icon size={iconSize} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
