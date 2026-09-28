import { useEffect } from 'react';
import { useAppStore } from '../store';
import { viewResources } from '../store/selectors';
import { hasOpenLayer } from '../components/ui/layerStack';

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
};

/** Ctrl/Cmd+K (palette), Escape (inspector/selection), Ctrl/Cmd+A (select visible items). */
export const useGlobalShortcuts = (): void => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useAppStore.getState();
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;

      if (mod && key === 'k') {
        event.preventDefault();
        if (state.activeModal === 'palette') state.closeModal();
        // Another open layer owns the screen; opening the palette over it would drop its state.
        else if (!state.confirmRequest && !hasOpenLayer()) state.openModal('palette');
        return;
      }

      if (event.key === 'Escape') {
        if (event.defaultPrevented || hasOpenLayer()) return;
        // Escape inside a text field belongs to the field, not the inspector around it.
        if (isEditableTarget(event.target)) return;
        if (state.selectedResourceId) state.selectResource(null);
        else if (state.batchSelectedIds.length > 0) state.clearBatch();
        return;
      }

      if (mod && key === 'a') {
        if (isEditableTarget(event.target) || hasOpenLayer()) return;
        if (state.page !== 'library') return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        const visible = viewResources(state);
        const selected = new Set(state.batchSelectedIds);
        const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
        state.setBatch(allSelected ? [] : visible.map((r) => r.id));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
};
