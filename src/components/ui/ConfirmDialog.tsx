import React, { useRef } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { cx } from './cx';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation on top of Modal: `alertdialog`, Cancel has the initial focus. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const Icon = destructive ? AlertTriangle : HelpCircle;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={message}
      role="alertdialog"
      size="sm"
      initialFocus={cancelRef}
      bodyClassName="hidden"
      icon={
        <span
          aria-hidden
          className={cx(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
            destructive ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent-text',
          )}
        >
          <Icon size={18} />
        </span>
      }
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
};
