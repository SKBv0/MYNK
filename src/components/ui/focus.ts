import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const isRendered = (el: HTMLElement): boolean => {
  // A real browser always lays out the document element; jsdom gives everything zero rects.
  if (document.documentElement.getClientRects().length === 0) return !el.closest('[hidden]');
  return el.getClientRects().length > 0;
};

/** Visible, tabbable descendants in DOM order. */
export const focusableWithin = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hasAttribute('inert') &&
      !el.closest('[inert]') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      el.tabIndex >= 0 &&
      // Not rendered (display:none, hidden ancestor): focusing it would silently do nothing.
      isRendered(el),
  );

/** Keeps Tab / Shift+Tab inside `root`. Returns true when the event was handled. */
export const trapTab = (event: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement): boolean => {
  if (event.key !== 'Tab') return false;
  const items = focusableWithin(root);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
};

/** Focuses `el` if it is still in the document. */
export const restoreFocus = (el: Element | null) => {
  if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
};
