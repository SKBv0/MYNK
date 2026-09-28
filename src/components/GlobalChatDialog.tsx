import React, { useRef } from 'react';
import AICopilot from './AICopilot';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { useGuardedClose } from '../hooks/useGuardedClose';
import { Modal } from './ui';

/** Library-wide chat dialog; a single instance that shows the full history. */
const GlobalChatDialog: React.FC = () => {
  const isOpen = useAppStore((s) => s.activeModal === 'globalChat');
  const closeModal = useAppStore((s) => s.closeModal);
  const selectResource = useAppStore((s) => s.selectResource);
  const { t } = useTranslation();
  const busyRef = useRef(false);
  const close = useGuardedClose(() => busyRef.current, closeModal);

  const openResource = (id: string) => {
    closeModal();
    selectResource(id);
  };

  return (
    <Modal
      open={isOpen}
      onClose={close}
      title={t.chat.globalTitle}
      hideHeader
      size="xl"
      className="h-full max-h-chat"
      padded={false}
      bodyClassName="flex flex-col"
    >
      <AICopilot
        onOpenResource={openResource}
        onClose={close}
        onBusyChange={(busy) => {
          busyRef.current = busy;
        }}
      />
    </Modal>
  );
};

export default GlobalChatDialog;
