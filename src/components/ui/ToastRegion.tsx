import React from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import type { Toast, ToastType } from '../../types';
import { useAppStore } from '../../store';
import { isDockVisible } from '../../store/selectors';
import { useTranslation } from '../../hooks/useTranslation';
import { cx } from './cx';
import { dockAwareBottom } from './styles';
import { Button } from './Button';
import { IconButton } from './IconButton';

const ICONS: Record<ToastType, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const TONE: Record<ToastType, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-info',
};

/**
 * Toasts sit in two always-mounted live regions, so each arrival is announced:
 * errors in the `alert` list, the rest in the polite `status` list.
 */
export const ToastRegion: React.FC = () => {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const holdToast = useAppStore((s) => s.holdToast);
  // Toasts move above the batch action dock while it is shown.
  const dockVisible = useAppStore(isDockVisible);
  const { t } = useTranslation();

  const renderToast = (toast: Toast) => {
    const Icon = ICONS[toast.type];
    return (
      <div
        key={toast.id}
        // Reading or reaching for the button must not race the dismiss timer.
        onPointerEnter={() => holdToast(toast.id, true)}
        onPointerLeave={() => holdToast(toast.id, false)}
        onFocusCapture={() => holdToast(toast.id, true)}
        onBlurCapture={() => holdToast(toast.id, false)}
        className="pointer-events-auto flex animate-rise-in items-start gap-3 rounded-md border border-line bg-surface-2 py-3 pl-4 pr-2 shadow-lg"
      >
        <Icon size={18} aria-hidden className={cx('mt-0.5 shrink-0', TONE[toast.type])} />
        <p className="min-w-0 flex-1 break-words text-base text-fg">{toast.message}</p>
        {toast.action && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 text-accent-text"
            onClick={() => {
              toast.action?.run();
              dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </Button>
        )}
        <IconButton
          label={t.toast.dismiss}
          icon={X}
          size="xs"
          tooltip={false}
          onClick={() => dismissToast(toast.id)}
        />
      </div>
    );
  };

  return (
    <section
      aria-label={t.toast.region}
      className={cx(
        'pointer-events-none absolute inset-x-6 z-toast flex flex-col items-end',
        dockAwareBottom(dockVisible),
      )}
    >
      <div role="status" className="flex w-full max-w-sm flex-col gap-2">
        {toasts.filter((toast) => toast.type !== 'error').map(renderToast)}
      </div>
      <div role="alert" className="mt-2 flex w-full max-w-sm flex-col gap-2 empty:mt-0">
        {toasts.filter((toast) => toast.type === 'error').map(renderToast)}
      </div>
    </section>
  );
};
