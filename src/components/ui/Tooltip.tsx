import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';

export type TooltipSide = 'top' | 'left' | 'right';

type TriggerProps = React.HTMLAttributes<HTMLElement> & { 'aria-describedby'?: string | undefined };

interface TooltipProps {
  content: React.ReactNode;
  /** A single element that accepts DOM event props (button, link, …). */
  children: React.ReactElement<TriggerProps>;
  side?: TooltipSide;
  /** Adds `aria-describedby` while open; off when content only repeats the trigger's name. */
  describe?: boolean;
}

const GAP = 8;
/** Hover delay in ms; keyboard focus uses the shorter `FOCUS_DELAY`. */
const HOVER_DELAY = 450;
const FOCUS_DELAY = 250;

const isFocusVisible = (el: Element): boolean => {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
};

/** Accessible tooltip: opens on hover/focus (delayed), closes on blur/leave/Escape. */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = 'top',
  describe = true,
}) => {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback((el: HTMLElement, wait: number) => {
    clear();
    timer.current = setTimeout(() => setAnchor(el), wait);
  }, []);

  const hide = useCallback(() => {
    clear();
    setAnchor(null);
    setPosition(null);
  }, []);

  useEffect(() => clear, []);

  useEffect(() => {
    if (!anchor) return undefined;
    // Capture phase, so stop the event here: one Escape closes the tooltip, not the dialog under it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      hide();
    };
    const onScroll = () => hide();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, hide]);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const rect = anchor.getBoundingClientRect();
    const tip = bubble.getBoundingClientRect();
    let top = rect.top - tip.height - GAP;
    let left = rect.left + rect.width / 2 - tip.width / 2;
    if (side === 'top' && top < 4) top = rect.bottom + GAP;
    if (side === 'left') {
      top = rect.top + rect.height / 2 - tip.height / 2;
      left = rect.left - tip.width - GAP;
    } else if (side === 'right') {
      top = rect.top + rect.height / 2 - tip.height / 2;
      left = rect.right + GAP;
    }
    const maxLeft = window.innerWidth - tip.width - 4;
    const maxTop = window.innerHeight - tip.height - 4;
    setPosition({
      top: Math.max(4, Math.min(top, maxTop)),
      left: Math.max(4, Math.min(left, maxLeft)),
    });
  }, [anchor, side, content]);

  if (content === null || content === undefined || content === '') return children;

  const props = children.props;
  const open = anchor !== null;
  const describedBy =
    describe && open
      ? [props['aria-describedby'], id].filter(Boolean).join(' ')
      : props['aria-describedby'];

  const trigger = React.cloneElement(children, {
    'aria-describedby': describedBy,
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (event.pointerType !== 'touch') show(event.currentTarget, HOVER_DELAY);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      props.onPointerLeave?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
      if (isFocusVisible(event.currentTarget)) show(event.currentTarget, FOCUS_DELAY);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(event);
      hide();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      props.onPointerDown?.(event);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={cx(
              'pointer-events-none fixed z-tooltip max-w-xs rounded-sm border border-line bg-surface-3 px-2 py-1 text-sm text-fg shadow-md',
              position ? 'animate-fade-in' : 'invisible',
            )}
            style={position ?? { top: 0, left: 0 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
};
