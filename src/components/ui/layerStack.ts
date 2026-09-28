import { useEffect } from 'react';
import { useLatest } from '../../hooks/useLatest';

/** Stack of dismissible layers (modals, drawers, menus); Escape closes only the top-most one. */
interface Layer {
  id: number;
  onEscape: () => void;
}

const layers: Layer[] = [];
let nextId = 1;
let listening = false;

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.onEscape();
};

export const pushLayer = (onEscape: () => void): (() => void) => {
  const layer = { id: nextId++, onEscape };
  layers.push(layer);
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    listening = true;
  }
  return () => {
    const index = layers.findIndex((item) => item.id === layer.id);
    if (index >= 0) layers.splice(index, 1);
  };
};

export const hasOpenLayer = (): boolean => layers.length > 0;

/** Registers a layer while `active`; `onEscape` may change between renders. */
export const useLayer = (active: boolean, onEscape: () => void): void => {
  const handler = useLatest(onEscape);
  useEffect(() => {
    if (!active) return undefined;
    return pushLayer(() => handler.current());
  }, [active, handler]);
};
