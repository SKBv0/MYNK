import { useAppStore } from '../store';
import { useTranslation } from './useTranslation';

/**
 * Close handler that asks first while `blocked()` is true, so an answer still arriving is not
 * discarded.
 */
export const useGuardedClose = (blocked: () => boolean, close: () => void): (() => void) => {
  const { t } = useTranslation();
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  return () => {
    if (!blocked()) {
      close();
      return;
    }
    requestConfirm({
      title: t.common.stopTitle,
      message: t.common.stopMessage,
      confirmLabel: t.common.stopAndClose,
      onConfirm: close,
    });
  };
};
