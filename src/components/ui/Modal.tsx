import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from './cx';
import { IconButton } from './IconButton';
import { useLayer } from './layerStack';
import { focusableWithin, restoreFocus, trapTab } from './focus';
import { useAppStore } from '../../store';
import { translations } from '../../translations';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Keeps the title for assistive tech only (the body shows its own heading). */
  hideHeader?: boolean;
  size?: ModalSize;
  role?: 'dialog' | 'alertdialog';
  /** Element focused on open; defaults to `[data-autofocus]`, then the first control. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  placement?: 'center' | 'top';
  className?: string;
  bodyClassName?: string;
  /** Default body padding; turn off for edge-to-edge content. */
  padded?: boolean;
  icon?: React.ReactNode;
}

const SIZES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/** The single modal shell: portal, `role="dialog"`, focus trap, focus return on close. */
export const Modal: React.FC<ModalProps> = ({ open, ...props }) =>
  open ? createPortal(<ModalPanel {...props} />, document.body) : null;

const ModalPanel: React.FC<Omit<ModalProps, 'open'>> = ({
  onClose,
  title,
  description,
  hideHeader = false,
  size = 'md',
  role = 'dialog',
  initialFocus,
  children,
  footer,
  placement = 'center',
  className,
  bodyClassName,
  padded = true,
  icon,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** Where the current press started and ended: only a press entirely on the overlay closes. */
  const press = useRef({ down: false, up: false });
  const lang = useAppStore((s) => s.lang);
  const t = translations[lang];

  // Read once at open time: the initial focus target never changes while the modal is open.
  const initialFocusRef = useRef(initialFocus);

  useLayer(true, onClose);

  useEffect(() => {
    const trigger = document.activeElement;
    const panel = panelRef.current;
    if (panel) {
      const target =
        initialFocusRef.current?.current ??
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        focusableWithin(panel).find((el) => !el.hasAttribute('data-modal-close')) ??
        panel;
      target.focus({ preventScroll: true });
    }
    return () => restoreFocus(trigger);
  }, []);

  return (
    <div
      data-modal-overlay
      // Capture phase: only a press starting and ending on the overlay itself closes it.
      onPointerDownCapture={(event) => {
        press.current = { down: event.target === overlayRef.current, up: false };
      }}
      onPointerUpCapture={(event) => {
        press.current.up = event.target === overlayRef.current;
      }}
      className={cx(
        'fixed inset-x-0 bottom-0 top-titlebar z-modal flex justify-center p-6',
        placement === 'top' ? 'items-start pt-16' : 'items-center',
      )}
    >
      <div
        ref={overlayRef}
        aria-hidden
        className="absolute inset-0 animate-fade-in bg-surface-overlay"
        onClick={() => {
          const { down, up } = press.current;
          press.current = { down: false, up: false };
          if (down && up) onClose();
        }}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-focus-container=""
        onKeyDown={(event) => {
          if (panelRef.current) trapTab(event, panelRef.current);
        }}
        className={cx(
          'relative flex max-h-full w-full animate-dialog-in flex-col overflow-hidden rounded-lg border border-line bg-surface-1 shadow-lg',
          SIZES[size],
          className,
        )}
      >
        <div
          className={cx(
            'flex shrink-0 items-start gap-3 px-6 pt-5',
            hideHeader ? 'sr-only' : 'pb-4',
          )}
        >
          {icon}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-md font-semibold text-fg">
              {title}
            </h2>
            {/* A div, not a <p>: ConfirmDialog passes arbitrary block content as the description. */}
            {description && (
              <div id={descriptionId} className="mt-1 text-base text-fg-muted">
                {description}
              </div>
            )}
          </div>
          {!hideHeader && (
            <IconButton
              label={t.common.close}
              icon={X}
              size="sm"
              onClick={onClose}
              data-modal-close=""
              className="-mr-2 -mt-1"
            />
          )}
        </div>
        <div className={cx('min-h-0 flex-1 overflow-y-auto', padded && 'px-6 pb-6', bodyClassName)}>
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-subtle bg-surface-2 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
