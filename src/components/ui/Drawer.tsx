import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from './layerStack';
import { restoreFocus, trapTab } from './focus';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the complementary region. */
  label: string;
  children: React.ReactNode;
}

/** Right-hand overlay panel: `role="complementary"`, focus trapped, Escape closes it. */
export const Drawer: React.FC<DrawerProps> = ({ open, ...props }) =>
  open ? createPortal(<DrawerPanel {...props} />, document.body) : null;

const DrawerPanel: React.FC<Omit<DrawerProps, 'open'>> = ({ onClose, label, children }) => {
  const panelRef = useRef<HTMLElement>(null);
  useLayer(true, onClose);

  useEffect(() => {
    const trigger = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    return () => restoreFocus(trigger);
  }, []);

  return (
    <>
      <div
        aria-hidden
        className="fixed inset-x-0 bottom-0 top-titlebar z-drawer animate-fade-in bg-surface-overlay"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="complementary"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-focus-container=""
        // The drawer covers the app behind its overlay, so Tab stays inside it just like Modal.
        onKeyDown={(event) => {
          if (panelRef.current) trapTab(event, panelRef.current);
        }}
        className="fixed bottom-0 right-0 top-titlebar z-drawer flex w-inspector max-w-full animate-drawer-in flex-col border-l border-line bg-surface-1 shadow-lg"
      >
        {children}
      </aside>
    </>
  );
};
