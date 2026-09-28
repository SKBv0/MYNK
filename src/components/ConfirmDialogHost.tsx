import React from 'react';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { ConfirmDialog as ConfirmPrimitive } from './ui';

/** Store-driven confirmation dialog, replacing native `confirm()`. */
const ConfirmDialogHost: React.FC = () => {
  const request = useAppStore((s) => s.confirmRequest);
  const resolveConfirm = useAppStore((s) => s.resolveConfirm);
  const { t } = useTranslation();

  return (
    <ConfirmPrimitive
      open={request !== null}
      title={request?.title ?? ''}
      message={request?.message ?? ''}
      confirmLabel={request?.confirmLabel ?? ''}
      cancelLabel={t.common.cancel}
      destructive={request?.danger}
      onConfirm={() => resolveConfirm(true)}
      onCancel={() => resolveConfirm(false)}
    />
  );
};

export default ConfirmDialogHost;
